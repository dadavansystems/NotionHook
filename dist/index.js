const core = require("@actions/core");
const github = require("@actions/github");
const { Client } = require("@notionhq/client");
const { Octokit } = require("@octokit/core");
const { restEndpointMethods } = require("@octokit/plugin-rest-endpoint-methods");

async function createCommit(notion, commits) {
  let fileFormat = core.getInput("files_format");
  if (core.getInput("token") === "") fileFormat = "none";
  var files = await getFiles();
  for (const commit of commits) {
    const array = commit.message.split(/\r?\n/);
    const title = array.shift();
    let description = "";
    array.forEach((element) => {
      description += " " + element;
    });

    // Optional: your task extraction and Notion search code
    const taskIndex = commit.message.indexOf("atnt:");
    let task = "";
    if (taskIndex >= 0) {
      task = commit.message.substring(taskIndex + 5).trim();
    }

    // This line assumes you implement page search differently; be sure notion.pages.filter is valid or replace
    let page = null;
    try {
      const searchResp = await notion.databases.query({
        database_id: core.getInput("task_database_id"),
        filter: {
          property: "Name", // Change to your task title property exact name
          title: {
            equals: task,
          },
        },
      });
      page = searchResp.results[0];
    } catch (error) {
      core.info("Task search error: " + error.message);
    }

    let filesBlock;
    switch (fileFormat) {
      case "text-list":
        core.info("Formatting Notion Block for:");
        core.info(files);
        filesBlock = {
          object: "block",
          type: "toggle",
          toggle: {
            text: [{ type: "text", text: { content: "Files" }, annotations: { bold: true } }],
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
        break;
      case "none":
        core.info("No file will be listed");
        filesBlock = null;
        break;
      default:
        core.setFailed("Other files list types not supported or file type not specified.");
        return;
    }

    // Await notion.pages.create to ensure it finishes before proceeding
    await notion.pages.create({
      parent: { database_id: core.getInput("notion_database") },
      properties: {
        title: {
          title: [{ type: "text", text: { content: title } }],
        },
        ...(page ? { task: { relation: [{ id: page.id }] } } : {}),
        [core.getInput("commit_url")]: { url: commit.url },
        [core.getInput("commit_id")]: { rich_text: [{ type: "text", text: { content: commit.id } }] },
        [core.getInput("commit_description")]: { rich_text: [{ type: "text", text: { content: description } }] },
        [core.getInput("commit_project")]: { multi_select: [{ name: github.context.repo.repo }] },
      },
      children: filesBlock ? [filesBlock] : [],
    });
  }
}

(async () => {
  try {
    const notion = new Client({ auth: core.getInput("notion_secret") });
    const commits = github.context.payload.commits;
    const base = github.context.payload.before;
    const head = github.context.payload.after;

    if (commits && commits.length > 0) {
      // Normal branch push with multiple commits
      await createCommit(notion, commits);
    } else if (base === "0000000000000000000000000000000000000000") {
      // First push (no valid base commit)
      const octokit = github.getOctokit(core.getInput("token"));
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
    } else {
      // Likely a tag event or no commits array: process tagged commit
      const octokit = github.getOctokit(core.getInput("token"));
      const repo = github.context.repo;
      const tagRef = github.context.payload.ref; // e.g., "refs/tags/v1.0.0"
      const tagName = tagRef.replace('refs/tags/', '');

      // Get ref info of the tag
      const { data: refData } = await octokit.git.getRef({
        owner: repo.owner,
        repo: repo.repo,
        ref: `tags/${tagName}`,
      });

      let commitSHA;

      if (refData.object.type === 'commit') {
        commitSHA = refData.object.sha;
      } else if (refData.object.type === 'tag') {
        // Annotated tag, get the tagged object
        const { data: tagData } = await octokit.git.getTag({
          owner: repo.owner,
          repo: repo.repo,
          tag_sha: refData.object.sha,
        });
        commitSHA = tagData.object.sha;
      } else {
        throw new Error(`Unexpected tag object type: ${refData.object.type}`);
      }

      // Now fetch the commit details with resolved SHA
      const { data: commit } = await octokit.rest.repos.getCommit({
        owner: repo.owner,
        repo: repo.repo,
        ref: commitSHA,
      });

      await createCommit(notion, [singleCommit]);
    }
  } catch (error) {
    core.setFailed(error.message);
  }
})();

async function getFiles() {
  try {
    const MyOctokit = Octokit.plugin(restEndpointMethods);
    const octokit = new MyOctokit({
      auth: core.getInput("token", { required: true }),
    });
    const format = core.getInput("files_format", { required: true });

    if (format !== "text-list" && format !== "none") {
      core.setFailed("file output format not supported.");
      return "";
    }
    core.debug(`Payload keys: ${Object.keys(github.context.payload)}`);
    const eventName = github.context.eventName;

    let base, head;
    switch (eventName) {
      case "pull_request":
        base = github.context.payload.pull_request.base.sha;
        head = github.context.payload.pull_request.head.sha;
        break;
      case "push":
        base = github.context.payload.before;
        head = github.context.payload.after;
        break;
      default:
        core.setFailed(`This action only supports pull requests and pushes, ${eventName} events are not supported.`);
        return "";
    }

    core.info(`Base commit: ${base}`);
    core.info(`Head commit: ${head}`);

    if (!base || !head) {
      core.setFailed(`The base and head commits are missing from the payload for this ${eventName} event.`);
      return "";
    }

    if (base === "0000000000000000000000000000000000000000") {
      core.info("First push detected, no base commit to compare.");
      return "";
    }

    const response = await octokit.rest.repos.compareCommits({
      base,
      head,
      owner: github.context.repo.owner,
      repo: github.context.repo.repo,
    });

    if (response.status !== 200) {
      core.setFailed(
        `The GitHub API for comparing the base and head commits for this ${eventName} event returned ${response.status}, expected 200.`
      );
      return "";
    }

    if (response.data.status !== "ahead") {
      core.setFailed(`The head commit for this ${eventName} event is not ahead of the base commit.`);
      return "";
    }

    const files = response.data.files;
    const all = [],
      added = [],
      modified = [],
      removed = [],
      renamed = [],
      addedModified = [];
    for (const file of files) {
      const filename = file.filename;
      if (format === "text-list" && filename.includes(" ")) {
        core.setFailed(
          "One of your files includes a space. Consider using a different output format or removing spaces from your filenames."
        );
      }
      all.push(filename);
      switch (file.status) {
        case "added":
          added.push(filename);
          addedModified.push(filename);
          break;
        case "modified":
          modified.push(filename);
          addedModified.push(filename);
          break;
        case "removed":
          removed.push(filename);
          break;
        case "renamed":
          renamed.push(filename);
          break;
        default:
          core.setFailed(`Unsupported file status '${file.status}'`);
      }
    }

    switch (format) {
      case "text-list":
        return all.join(" ");
      case "csv":
        return all.join(",");
      case "json":
        return JSON.stringify(all);
      case "none":
        return "";
    }
  } catch (error) {
    core.info("error " + error + " occurred");
    return "";
  }
}
