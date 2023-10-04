import { ZeplinApi, Configuration } from "@zeplin/sdk";
import Progress from "progress";
import axios from "axios";
import fs from "fs/promises";
import { config } from "dotenv";
import rateLimit from "axios-rate-limit";
import { Command } from "commander";
import pLimit from "p-limit";
import Jimp from "jimp";

// Set your dotenv config to the root directory where the .env file lives
config({ path: ".env" });

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

const getLayersData = async (screen, projectId) => {
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
      content: layer.content,
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

const downloadAsset = async ({ screenName, url, filename }, dir, progress) => {
  try {
    const { data } = await axios.get(url, { responseType: "stream" });
    await fs.mkdir(`${dir}/${screenName}`, { recursive: true });
    await fs.writeFile(`${dir}/${screenName}/${filename}`, data);

    await Jimp.read(`${dir}/${screenName}/${filename}`)
      .then((image) => {
        mF.actualAssetSize({ screenName, filename }, image.bitmap.width, image.bitmap.height);
      })
      .catch((err) => {
        activityLog.add(`Error reading image ${filename}`);
        activityLog.add(err);
      });
  } catch (err) {
    activityLog.add(`Error downloading ${screenName}`);
    activityLog.add(err.config.url);
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
      config: null,
      layers: {
        template: {
          id: null,
          name: null,
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
              actualSize: {
                width: null,
                height: null,
              },
            },
            data: [],
          },
          content: null,
        },
        data: [],
      },
    },
    data: [],
  },
};
const mF = {
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
        template.name = layer.name;
        template.sourceId = layer.sourceId;
        template.rect.width = layer.rect.width;
        template.rect.height = layer.rect.height;
        template.rect.x = layer.rect.x;
        template.rect.y = layer.rect.y;
        template.content = layer.content;

        metadata.screens.data[screenIndex].layers.data.push(template);
      } else {
        activityLog.add(`Error: Unable to identify screen for layer ${layer.name}`);
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
          activityLog.add(`Error: Unable to identify layer for asset ${asset.displayName}`);
        }
      } else {
        activityLog.add(`Error: Unable to identify screen for asset ${asset.displayName}`);
      }
    });
    metadata.screens.data.forEach((screen) => {
      screen.layers.data.forEach((layer) => {
        delete layer.assets.template;
      });
    });
  },
  actualAssetSize: (asset, width, height) => {
    let screenIndex = metadata.screens.data.findIndex((screen) => screen.name === asset.screenName);
    if (screenIndex !== -1) {
      let layerIndex = metadata.screens.data[screenIndex].layers.data.findIndex((layer) => layer.assets.data.some((a) => a.filename === asset.filename));
      if (screenIndex !== -1 && layerIndex !== -1) {
        let assetIndex = metadata.screens.data[screenIndex].layers.data[layerIndex].assets.data.findIndex((a) => a.filename === asset.filename);
        if (assetIndex !== -1) {
          metadata.screens.data[screenIndex].layers.data[layerIndex].assets.data[assetIndex].actualSize.width = width;
          metadata.screens.data[screenIndex].layers.data[layerIndex].assets.data[assetIndex].actualSize.height = height;

          let layerWidth = metadata.screens.data[screenIndex].layers.data[layerIndex].rect.width;
          let layerHeight = metadata.screens.data[screenIndex].layers.data[layerIndex].rect.height;

          let tolerance = 3;

          if (Math.abs(layerWidth - width) > tolerance || Math.abs(layerHeight - height) > tolerance) {
            activityLog.add(
              `Warning: rect dimensions for ${asset.filename} do not match actual file dimensions. Rect: ${layerWidth}x${layerHeight} Actual: ${width}x${height}`
            );
          }
        } else {
          activityLog.add(`Error: Unable to identify asset for filename ${asset.filename}`);
        }
      } else {
        activityLog.add(`Error: Unable to identify layer for asset with filename ${asset.filename}`);
      }
    } else {
      activityLog.add(`Error: Unable to identify screen asset with filename ${asset.filename}`);
    }
  },
  config: () => {
    metadata.screens.data.forEach((screen) => {
      let configLayer = screen.layers.data.find((layer) => layer.name === "Config box");
      if (configLayer) {
        let configContents = configLayer.content;
        configContents = configContents.replaceAll("\n", "");
        configContents = configContents.replaceAll("“", '"');
        configContents = configContents.replaceAll("”", '"');

        let configJSON;
        try {
          configJSON = JSON.parse(configContents);
        } catch (err) {
          activityLog.add(`Error parsing JSON for screen ${screen.name}`);
          activityLog.add(err);
        }

        screen.config = configJSON;
      } else {
        activityLog.add(`Error: Unable to find config layer for screen ${screen.name}`);
      }
    });
  },
  save: (folder, data) => {
    fs.writeFile(`${folder}/metadata.json`, JSON.stringify(data, null, 2), (err) => {
      if (err) {
        activityLog.add(err);
      }
    });
  },
};

const activityLog = {
  data: "",
  add: (data) => {
    console.log(data);
    activityLog.data = activityLog.data + "\n" + data;
  },
  save: (folder) => {
    fs.writeFile(`${folder}/log.txt`, activityLog.data, (err) => {
      if (err) {
        activityLog.add(err);
      }
    });
  },
};

// add command line options
program
  .requiredOption("-p, --projectId <projectId>", "Project ID")
  .option("-s, --screenId <screenId>", "Screen ID (optional)")
  .option("-mo, --metadataOnly", "Download metadata only (no assets)", false)
  .option("-f, --formats <formats...>", "Formats to download", ["png", "jpg", "webp", "svg", "pdf"])
  .option("-e, --densities <density...>", "Density to download", ["1", "1.5", "2", "3", "4"])
  .action(async ({ projectId, screenId, metadataOnly, formats, densities }) => {
    mF.projectId(projectId);

    const { name: projectName } = await getProjectProperties(projectId);
    mF.projectName(projectName);

    const projectScreens = await getProjectScreens(projectId, screenId);
    mF.screens(projectScreens);

    const layers = await Promise.all(projectScreens.map(async (screen) => getLayersData(screen, projectId)));
    mF.layers(layers);

    const assets = await Promise.all(projectScreens.map(async (screen) => getAssetData(screen, projectId, formats, densities)));
    mF.assets(assets);

    mF.config();

    const assetsBar = new Progress("  Downloading project assets [:bar] :rate/bps :percent :etas", {
      complete: "=",
      incomplete: " ",
      width: 20,
      total: assets.flat().length,
    });

    let directory = metadata.project.name.replaceAll("/", "-") + "__assets";

    // Remove existing Output folder and create new one at start of script
    await fs.rm(directory, { recursive: true, force: true });
    await fs.mkdir(directory);

    const limit = pLimit(20);

    if (!metadataOnly) {
      const downloadAssetPromises = assets.flat().map((asset) => limit(() => downloadAsset(asset, directory, assetsBar)));

      await Promise.all(downloadAssetPromises);
    }

    mF.save(directory, metadata);

    activityLog.save(directory);
  });

program.parse(process.argv);
