const core = require("@actions/core");
const github = require("@actions/github");
const { Client } = require("@notionhq/client");
const { Octokit } = require("@octokit/core");
const { restEndpointMethods } = require("@octokit/plugin-rest-endpoint-methods");

/**
 * Create a Notion page for each commit
 */
async function createCommit(notion, commits) {
  let fileFormat = core.getInput("files_format");
  if (core.getInput("token") === "") fileFormat = "none";
  const files = await getFiles();

  for (const commit of commits) {
    const array = commit.message.split(/\r?\n/);
    const title = array.shift();
    let description = array.join(" ");

    // Extract task reference "atnt: task-name"
    const taskIndex = commit.message.indexOf("atnt:");
    let task = "";
    if (taskIndex >= 0) {
      task = commit.message.substring(taskIndex + 5).trim();
    }

    // Search Notion task (optional)
    let page = null;
    try {
      const searchResp = await notion.databases.query({
        database_id: core.getInput("task_database_id"),
        filter: {
          property: "Name",
          title: { equals: task },
        },
      });
      page = searchResp.results[0];
    } catch (error) {
      core.info("Task search error: " + error.message);
    }

    // Formatting files block for Notion
    let filesBlock = null;

    if (fileFormat === "text-list") {
      filesBlock = {
        object: "block",
        type: "toggle",
        toggle: {
          text: [
            {
              type: "text",
              text: { content: "Files" },
              annotations: { bold: true },
            },
          ],
          children: [
            {
              type: "paragraph",
              paragraph: {
                text: [{ type: "text", text: { content: files } }],
              },
            },
          ],
        },
      };
    }

    // Create Notion page
    await notion.pages.create({
      parent: { database_id: core.getInput("notion_database") },
      properties: {
        title: {
          title: [{ type: "text", text: { content: title } }],
        },
        ...(page ? { task: { relation: [{ id: page.id }] } } : {}),
        [core.getInput("commit_url")]: { url: commit.url },
        [core.getInput("commit_id")]: {
          rich_text: [{ type: "text", text: { content: commit.id } }],
        },
        [core.getInput("commit_description")]: {
          rich_text: [{ type: "text", text: { content: description } }],
        },
        [core.getInput("commit_project")]: {
          multi_select: [{ name: github.context.repo.repo }],
        },
      },
      children: filesBlock ? [filesBlock] : [],
    });
  }
}

/**
 * Handle tag push events (refs/tags/vX.Y.Z)
 */
async function handleTagPush(notion) {
  const MyOctokit = Octokit.plugin(restEndpointMethods);
  const octokit = new MyOctokit({
    auth: core.getInput("token")
  });

  const repo = github.context.repo;
  const tagRef = github.context.payload.ref; // refs/tags/v1.0.0
  const tagName = tagRef.replace("refs/tags/", "");

  // Fetch reference
  const { data: refData } = await octokit.git.getRef({
    owner: repo.owner,
    repo: repo.repo,
    ref: `tags/${tagName}`,
  });

  let commitSHA;

  if (refData.object.type === "commit") {
    commitSHA = refData.object.sha; // lightweight tag
  } else if (refData.object.type === "tag") {
    const { data: tagObj } = await octokit.git.getTag({
      owner: repo.owner,
      repo: repo.repo,
      tag_sha: refData.object.sha,
    });

    commitSHA = tagObj.object.sha; // annotated tag → underlying commit
  } else {
    throw new Error(`Unexpected tag object type: ${refData.object.type}`);
  }

  // Fetch commit details
  const { data: commit } = await octokit.rest.repos.getCommit({
    owner: repo.owner,
    repo: repo.repo,
    ref: commitSHA,
  });

  const wrappedCommit = {
    id: commit.sha,
    url: commit.html_url,
    message: commit.commit.message,
  };

  await createCommit(notion, [wrappedCommit]);
}

/**
 * Main execution logic
 */
(async () => {
  try {
    const notion = new Client({ auth: core.getInput("notion_secret") });
    const payload = github.context.payload;
    const commits = payload.commits;

    const ref = payload.ref; // branch or tag
    const base = payload.before;
    const head = payload.after;

    // --------------------------------------------
    // 1️⃣ TAG PUSH EVENT
    // --------------------------------------------
    if (ref.startsWith("refs/tags/")) {
      await handleTagPush(notion);
      return;
    }

    // --------------------------------------------
    // 2️⃣ NORMAL BRANCH PUSH (multiple commits)
    // --------------------------------------------
    if (commits && commits.length > 0) {
      await createCommit(notion, commits);
      return;
    }

    // --------------------------------------------
    // 3️⃣ FIRST PUSH TO BRANCH (no base)
    // --------------------------------------------
    if (base === "0000000000000000000000000000000000000000") {
      const MyOctokit = Octokit.plugin(restEndpointMethods);
      const octokit = new MyOctokit({ auth: core.getInput("token") });

      const repo = github.context.repo;

      const { data: commit } = await octokit.rest.repos.getCommit({
        owner: repo.owner,
        repo: repo.repo,
        ref: head,
      });

      const singleCommit = {
        id: commit.sha,
        url: commit.html_url,
        message: commit.commit.message,
      };

      await createCommit(notion, [singleCommit]);
      return;
    }

    // Fallback (should never happen normally)
    throw new Error("Could not determine event type to process commit.");

  } catch (error) {
    core.setFailed(error.message);
  }
})();

/**
 * Compute changed files between commits
 */
async function getFiles() {
  try {
    const MyOctokit = Octokit.plugin(restEndpointMethods);
    const octokit = new MyOctokit({
      auth: core.getInput("token", { required: true }),
    });

    const eventName = github.context.eventName;
    let base, head;

    if (eventName === "pull_request") {
      base = github.context.payload.pull_request.base.sha;
      head = github.context.payload.pull_request.head.sha;
    } else if (eventName === "push") {
      base = github.context.payload.before;
      head = github.context.payload.after;
    }

    // Tag pushes always result in empty comparison → return nothing
    if (github.context.payload.ref.startsWith("refs/tags/")) {
      return "";
    }

    if (!base || !head) {
      return "";
    }

    const response = await octokit.rest.repos.compareCommits({
      base,
      head,
      owner: github.context.repo.owner,
      repo: github.context.repo.repo,
    });

    const files = response.data.files || [];

    return files.map(f => f.filename).join(" ");
  } catch (err) {
    core.info("File parsing error: " + err);
    return "";
  }
}
