const core = require("@actions/core");
const github = require("@actions/github");
const { Client } = require("@notionhq/client");

const { Octokit } = require("@octokit/rest");

function getOctokit() {
  return new Octokit({ auth: core.getInput("token") });
}

async function createCommit(notion, commits) {
  let fileFormat = core.getInput("files_format");
  if (core.getInput("token") === "") fileFormat = "none";

  const files = await getFiles();

  for (const commit of commits) {
    const array = commit.message.split(/\r?\n/);
    const title = array.shift();
    const description = array.join(" ");

    const taskIndex = commit.message.indexOf("atnt:");
    let task = "";
    if (taskIndex >= 0) task = commit.message.substring(taskIndex + 5).trim();

    let page = null;
    try {
      const searchResp = await notion.databases.query({
        database_id: core.getInput("task_database_id"),
        filter: {
          property: "Name",
          title: { equals: task }
        }
      });

      page = searchResp.results[0];
    } catch (err) {
      core.info("Task lookup failed: " + err.message);
    }

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
              annotations: { bold: true }
            }
          ],
          children: [
            {
              type: "paragraph",
              paragraph: {
                text: [{ type: "text", text: { content: files } }]
              }
            }
          ]
        }
      };
    }

    await notion.pages.create({
      parent: { database_id: core.getInput("notion_database") },
      properties: {
        title: {
          title: [{ type: "text", text: { content: title } }]
        },
        ...(page ? { task: { relation: [{ id: page.id }] } } : {}),
        [core.getInput("commit_url")]: { url: commit.url },
        [core.getInput("commit_id")]: {
          rich_text: [{ type: "text", text: { content: commit.id } }]
        },
        [core.getInput("commit_description")]: {
          rich_text: [{ type: "text", text: { content: description } }]
        },
        [core.getInput("commit_project")]: {
          multi_select: [{ name: github.context.repo.repo }]
        },
        ...(commit.tagName ? {
        Tag: {
          rich_text: [{ type: "text", text: { content: commit.tagName } }]
        },
        TagURL: { url: commit.tagUrl }
      } : {})
      },
      children: filesBlock ? [filesBlock] : []
    });
  }
}

async function handleTagPush(notion) {
  const octokit = getOctokit();
  const repo = github.context.repo;

  const tagRef = github.context.payload.ref; // refs/tags/v1.2.3
  const tagName = tagRef.replace("refs/tags/", "");

  // 1. Fetch the tag reference
  const { data: refData } = await octokit.git.getRef({
    owner: repo.owner,
    repo: repo.repo,
    ref: `tags/${tagName}`
  });

  let commitSHA;

  // Lightweight tag
  if (refData.object.type === "commit") {
    commitSHA = refData.object.sha;

  // Annotated tag
  } else if (refData.object.type === "tag") {
    const { data: tagObj } = await octokit.git.getTag({
      owner: repo.owner,
      repo: repo.repo,
      tag_sha: refData.object.sha
    });

    commitSHA = tagObj.object.sha;

  } else {
    throw new Error(`Unexpected tag object type: ${refData.object.type}`);
  }

  // 2. Fetch commit details
  const { data: commit } = await octokit.rest.repos.getCommit({
    owner: repo.owner,
    repo: repo.repo,
    ref: commitSHA
  });

  const tagUrl = `https://github.com/${owner}/${repository}/releases/tag/${tagName}`;

  const singleCommit = {
  id: commit.sha,
  url: commit.html_url,
  message: commit.commit.message,
  tagName,
  tagUrl
};

  await createCommit(notion, [singleCommit]);
}

(async () => {
  try {
    const notion = new Client({ auth: core.getInput("notion_secret") });
    const payload = github.context.payload;
    const commits = payload.commits;
    const ref = payload.ref;
    const base = payload.before;
    const head = payload.after;

    // 1️⃣ TAG PUSH EVENT
    if (ref.startsWith("refs/tags/")) {
      await handleTagPush(notion);
      return;
    }

    // 2️⃣ NORMAL PUSH WITH COMMITS
    if (commits && commits.length > 0) {
      await createCommit(notion, commits);
      return;
    }

    // 3️⃣ FIRST PUSH TO A BRANCH
    if (base === "0000000000000000000000000000000000000000") {
      const octokit = getOctokit();
      const repo = github.context.repo;

      const { data: commit } = await octokit.rest.repos.getCommit({
        owner: repo.owner,
        repo: repo.repo,
        ref: head
      });

      const singleCommit = {
        id: commit.sha,
        url: commit.html_url,
        message: commit.commit.message
      };

      await createCommit(notion, [singleCommit]);
      return;
    }

    throw new Error("Unexpected event structure — no commits or tag found.");
  } catch (err) {
    core.setFailed(err.message);
  }
})();

async function getFiles() {
  try {
    const octokit = getOctokit();
    const payload = github.context.payload;
    const eventName = github.context.eventName;

    // Tag pushes have no file diff
    if (payload.ref.startsWith("refs/tags/")) return "";

    let base, head;

    if (eventName === "pull_request") {
      base = payload.pull_request.base.sha;
      head = payload.pull_request.head.sha;
    } else if (eventName === "push") {
      base = payload.before;
      head = payload.after;
    } else {
      return "";
    }

    if (!base || !head) return "";

    const response = await octokit.rest.repos.compareCommits({
      owner: github.context.repo.owner,
      repo: github.context.repo.repo,
      base,
      head
    });

    const files = response.data.files || [];
    return files.map(f => f.filename).join(" ");
  } catch {
    return "";
  }
}
