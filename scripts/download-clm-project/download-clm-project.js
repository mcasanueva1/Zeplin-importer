import { ZeplinApi, Configuration } from "@zeplin/sdk";
import Progress from "progress";
import axios from "axios";
import fs from "fs/promises";
import { config } from "dotenv";
import rateLimit from "axios-rate-limit";
import { Command } from "commander";
import pLimit from "p-limit";

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

const getProjectScreens = async (projectId, screenId) => {
  const { data } = await zeplin.screens.getProjectScreens(projectId);

  if (screenId) {
    return data.filter((screen) => screen.id === screenId);
  } else {
    return data;
  }
};

const getLayerData = async (screen, projectId) => {
  const { id } = screen;
  const { data } = await zeplin.screens.getLatestScreenVersion(projectId, id);

  return data.layers.flatMap((layer) => {
    return {
      screenId: id,
      id: layer.id,
      sourceId: layer.sourceId,
      name: layer.name,
      type: layer.type,
      rect: {
        width: layer.rect.width,
        height: layer.rect.height,
        x: layer.rect.x,
        y: layer.rect.y,
      },
    };
  });
};

const getAssetData = async (screen, projectId, formats, densities) => {
  const { id, name } = screen;
  const { data } = await zeplin.screens.getLatestScreenVersion(projectId, id);

  return data.assets.flatMap(({ displayName, contents, layerSourceId, layerName }) => {
    // remove any asset that are not in the formats defined in PROJECT_OPTIONS.formats
    const filteredContents = contents.filter((content) => formats.includes(content.format) && densities.includes(content.density.toString()));
    return filteredContents.map(({ url, format, density }) => ({
      screenId: id,
      screenName: name,
      displayName,
      layerSourceId,
      layerName,
      url,
      format,
      density,
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

// metadata object to be saved to metadata.json
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
      layers: {
        template: {
          id: null,
          sourceId: null,
          rect: {
            width: null,
            height: null,
            x: 0,
            y: 0,
          },
          assets: {
            template: {
              displayName: null,
              filename: null,
              format: null,
              density: null,
            },
            data: [],
          },
        },
        data: [],
      },
    },
    data: [],
  },
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
  layers: (layers) => {
    layers.flat().forEach((layer) => {
      let screenIndex = metadata.screens.data.findIndex((screen) => screen.id === layer.screenId);
      if (screenIndex !== -1) {
        let template = JSON.parse(JSON.stringify(metadata.screens.data[screenIndex].layers.template));
        template.id = layer.id;
        template.sourceId = layer.sourceId;
        template.rect.width = layer.rect.width;
        template.rect.height = layer.rect.height;
        template.rect.x = layer.rect.x;
        template.rect.y = layer.rect.y;

        metadata.screens.data[screenIndex].layers.data.push(template);
      } else {
        console.log(`Error: Unable to identify screen for layer ${layer.name}`);
      }
    });
    metadata.screens.data.forEach((screen) => {
      delete screen.layers.template;
    });
  },
  assets: (assets) => {
    assets.flat().forEach((asset) => {
      let screenIndex = metadata.screens.data.findIndex((screen) => screen.id === asset.screenId);
      if (screenIndex !== -1) {
        let layerIndex = metadata.screens.data[screenIndex].layers.data.findIndex((layer) => layer.sourceId === asset.layerSourceId);
        if (screenIndex !== -1 && layerIndex !== -1) {
          let template = JSON.parse(JSON.stringify(metadata.screens.data[screenIndex].layers.data[layerIndex].assets.template));
          template.displayName = asset.displayName;
          template.filename = asset.filename;
          template.format = asset.format;
          template.density = asset.density;
          metadata.screens.data[screenIndex].layers.data[layerIndex].assets.data.push(template);
        } else {
          console.log(`Error: Unable to identify layer for asset ${asset.displayName}`);
        }
      } else {
        console.log(`Error: Unable to identify screen for asset ${asset.displayName}`);
      }
    });
    metadata.screens.data.forEach((screen) => {
      screen.layers.data.forEach((layer) => {
        delete layer.assets.template;
      });
    });
  },
};

const saveMetadata = (folder, data) => {
  fs.writeFile(`${folder}/metadata.json`, JSON.stringify(data, null, 2), (err) => {
    if (err) {
      console.log(err);
    }
  });
};

// add command line options
program
  .requiredOption("-p, --projectId <projectId>", "Project ID")
  .option("-s, --screenId <screenId>", null)
  .option("-mo, --metadataOnly", "Download metadata only (no assets)", false)
  .option("-d, --directory <dir>", "Output directory", "Output")
  .option("-f, --formats <formats...>", "Formats to download", ["png", "jpg", "webp", "svg", "pdf"])
  .option("-e, --densities <density...>", "Density to download", ["1", "1.5", "2", "3", "4"])
  .action(async ({ projectId, screenId, metadataOnly, directory, formats, densities }) => {
    updateMetadata.projectId(projectId);

    const { name: projectName } = await getProjectProperties(projectId);
    updateMetadata.projectName(projectName);

    const projectScreens = await getProjectScreens(projectId, screenId);
    updateMetadata.screens(projectScreens);

    const layers = await Promise.all(projectScreens.map(async (screen) => getLayerData(screen, projectId)));
    updateMetadata.layers(layers);

    const assets = await Promise.all(projectScreens.map(async (screen) => getAssetData(screen, projectId, formats, densities)));
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

    saveMetadata(directory, metadata);
  });

program.parse(process.argv);
