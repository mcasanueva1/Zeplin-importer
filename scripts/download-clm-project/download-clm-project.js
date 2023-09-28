import { ZeplinApi, Configuration } from "@zeplin/sdk";
import Progress from "progress";
import axios from "axios";
import fs from "fs/promises";
import { config } from "dotenv";
import rateLimit from "axios-rate-limit";
import { Command } from "commander";
import pLimit from "p-limit";

//metadata template
let metadata = {
  source: "zeplin",
  project: {
    id: null,
    name: null,
  },
  screens: {
    template: {
      id: null,
      name: null,
      assets: {
        template: {

        },
        data: []
      }
    },
    data: []
  },
}

// Set your dotenv config to the root directory where the .env file lives
config({ path: "../../.env" });

// Extract PAT and Workspace from .env
const { PERSONAL_ACCESS_TOKEN } = process.env;

// use Commander to take in options from the command line
const program = new Command();

// Zeplin API rate limit is 200 requests per user per minute.
// Use rateLimit to extend Axios to only make 200 requests per minute (60,000ms)
const http = rateLimit(axios.create(), { maxRequests: 200, perMilliseconds: 60000 });

// Instantiate zeplin with access token, add our http client to the zeplin

const zeplin = new ZeplinApi(new Configuration({ accessToken: PERSONAL_ACCESS_TOKEN }), undefined, http);

const getProjectProperties = async (projectId) => {
  const { data } = await zeplin.projects.getProject(projectId);

  return data;
};

const getProjectScreens = async (projectId) => {
  const { data } = await zeplin.screens.getProjectScreens(projectId);

  return data;
};

const getAssetData = async (screen, projectId, formats) => {
  const { id, name } = screen;
  const { data } = await zeplin.screens.getLatestScreenVersion(projectId, id);
  return data.assets.flatMap(({ displayName, contents }) => {
    // remove any asset that are not in the formats defined in PROJECT_OPTIONS.formats
    const filteredContents = contents.filter((content) => formats.includes(content.format));
    return filteredContents.map(({ url, format, density }) => ({
      screenId: id,
      screenName: name,
      url,
      filename: `${displayName.replaceAll("/", "-")}-${density}x.${format}`,
    }));
  });
};

const downloadAsset = async ({ name, url, filename }, dir, progress) => {
  try {
    const { data } = await axios.get(url, { responseType: "stream" });
    await fs.mkdir(`${dir}/${name}`, { recursive: true });
    await fs.writeFile(`${dir}/${name}/${filename}`, data);
  } catch (err) {
    console.log(`Error downloading ${name}`);
    console.log(err.config.url);
  }
  progress.tick();
};

const updateMetadata = {
  projectId: (projectId) => {
    metadata.project.id = projectId;
  },
  projectName: (projectName) => {
    metadata.project.name = projectName;
  },
  screens: (screens) => {
    screens.forEach((screen) => {
      let template = JSON.parse(JSON.stringify(metadata.screens.template));
      template.id = screen.id;
      template.name = screen.name;
      metadata.screens.data.push(template);
    });
    delete metadata.screens.template;
  },
  assets: (assets) => {
    
    assets.forEach((asset) => {
      let screenIndex = metadata.screens.data.findIndex((screen) => screen.id === asset.screenId);
      console.log(screenIndex)
    });
  }
}

// add command line options
program
  .requiredOption("-p, --projectId <projectId>", "Project ID")
  .option("-mo, --metadataOnly", "Download metadata only (no assets)", false)
  .option("-d, --directory <dir>", "Output directory", "Output")
  .option("-f, --formats <formats...>", "Formats to download", ["png", "jpg", "webp", "svg", "pdf"])
  .action(async ({ projectId, metadataOnly, directory, formats }) => {
    updateMetadata.projectId(projectId);

    const { name: projectName } = await getProjectProperties(projectId);
    updateMetadata.projectName(projectName);

    const projectScreens = await getProjectScreens(projectId);
    updateMetadata.screens(projectScreens);

    const assets = (await Promise.all(projectScreens.map(async (screen) => getAssetData(screen, projectId, formats)))).flat();
    updateMetadata.assets(assets);

    const assetsBar = new Progress("  Downloading project assets [:bar] :rate/bps :percent :etas", {
      complete: "=",
      incomplete: " ",
      width: 20,
      total: assets.length,
    });

    // Remove existing Output folder and create new one at start of script
    await fs.rm(directory, { recursive: true, force: true });
    await fs.mkdir(directory);

    const limit = pLimit(20);

    if (!metadataOnly) {
      const downloadAssetPromises = assets.map((asset) => limit(() => downloadAsset(asset, directory, assetsBar)));

      await Promise.all(downloadAssetPromises);
    }

    console.log(JSON.stringify(metadata));
  });

program.parse(process.argv);
