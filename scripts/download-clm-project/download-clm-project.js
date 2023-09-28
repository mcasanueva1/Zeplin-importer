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

const getLayerData = async (screen, projectId) => {
  const { id } = screen;
  const { data } = await zeplin.screens.getLatestScreenVersion(projectId, id);

  return { screenId: id, layers: data.layers };
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
      assets: {
        template: {
          displayName: null,
          filename: null,
          format: null,
          density: null,
          layer: {
            id: null,
            name: null,
          },
        },
        data: [],
      },
      layers: {
        template: {
          id: null,
          sourceId: null,
          name: null,
          type: null,
          rect: {
            width: null,
            height: null,
            x: 0,
            y: 0,
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
  assets: (assets) => {
    assets.forEach((asset) => {
      let screenIndex = metadata.screens.data.findIndex((screen) => screen.id === asset.screenId);
      if (screenIndex !== -1) {
        let template = JSON.parse(JSON.stringify(metadata.screens.data[screenIndex].assets.template));
        template.displayName = asset.displayName;
        template.filename = asset.filename;
        template.format = asset.format;
        template.density = asset.density;
        template.layer.id = asset.layerSourceId;
        template.layer.name = asset.layerName;
        metadata.screens.data[screenIndex].assets.data.push(template);
      }
    });
    metadata.screens.data.forEach((screen) => {
      delete screen.assets.template;
    });
  },
  layers: (screensLayers) => {
    screensLayers.forEach((screenLayers) => {
      let screenIndex = metadata.screens.data.findIndex((screen) => screen.id === screenLayers.screenId);
      if (screenIndex !== -1) {
        metadata.screens.data[screenIndex].layers.data = screenLayers.layers;
      }
    });
    // remove absolute position
    metadata.screens.data.forEach((screen) => {
      screen.layers.data.forEach((layer) => {
        delete layer.rect.absolute
      });
    });    
    // align layer fields with template
    metadata.screens.data.forEach((screen) => {
      screen.layers.data.forEach((layer) => {
        layer = updateMetadata.alignLayerFieldsWithTemplate(layer, screen.layers.template);
      });
    });
    // remove template
    metadata.screens.data.forEach((screen) => {
      delete screen.layers.template;
    });
    //combine layers and assets
    metadata.screens.data.forEach((screen) => {
      screen.assets.data.forEach((asset) => {
        screen.layers.data.forEach((layer) => {
          updateMetadata.updateLayerWithAsset(asset, layer)
        });
      });
    });
  },
  alignLayerFieldsWithTemplate: (layer, template) => {
    let layerKeys = Object.keys(layer);
    let templateKeys = Object.keys(template);
    let keysToRemove = layerKeys.filter((key) => !templateKeys.includes(key));
    keysToRemove.forEach((key) => {
      delete layer[key];
    });
    if (layer.layers) {
      layer.layers = layer.layers.map((layer) => updateMetadata.alignLayerFieldsWithTemplate(layer, template));
    }
    return layer;
  },
  updateLayerWithAsset: (asset, layer) => {
    if (layer.sourceId == asset.layer.id) {
      layer.asset = asset;
    }
    if (layer.layers) {
      layer.layers.forEach((layer) => updateMetadata.updateLayerWithAsset(asset, layer));
    }
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

    const assets = (await Promise.all(projectScreens.map(async (screen) => getAssetData(screen, projectId, formats, densities)))).flat();
    updateMetadata.assets(assets);

    const screensLayers = await Promise.all(projectScreens.map(async (screen) => getLayerData(screen, projectId)));
    updateMetadata.layers(screensLayers);

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
