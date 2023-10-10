import { ZeplinApi, Configuration } from "@zeplin/sdk";
import Progress from "progress";
import axios from "axios";
import fs from "fs/promises";
import { config } from "dotenv";
import rateLimit from "axios-rate-limit";
import { Command } from "commander";
import pLimit from "p-limit";
import Jimp from "jimp";
import path from "path";

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

const getProjectScreens = async (projectId, screenId, offset, limit) => {
  const { data } = await zeplin.screens.getProjectScreens(projectId, { offset: offset, limit: limit });

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
    }));
  });
};

const downloadAsset = async ({ screenName, url, displayName }, dir, progress) => {
  let filename;

  try {
    filename = metadata.screens.data
      .find((screen) => screen.name === screenName)
      .layers.data.find((layer) => layer.assets.data.length > 0 && layer.assets.data[0].displayName === displayName).assets.data[0].filename;
  } catch (err) {
    activityLog.add(screenName, `Error finding filename for ${displayName}`, err.message);
  }

  let slideFolderPath = `${dir}/${screenName}`;
  try {
    await fs.mkdir(slideFolderPath, { recursive: true });
  } catch (err) {}

  try {
    const { data } = await axios.get(url, { responseType: "stream" });
    await fs.writeFile(`${slideFolderPath}/${filename}`, data);
  } catch (err) {
    activityLog.add(screenName, `Error downloading ${filename}`, err.message);
  }

  await Jimp.read(`${dir}/${screenName}/${filename}`)
    .then((image) => {
      mF.actualAssetSize({ screenName, filename }, image.bitmap.width, image.bitmap.height);
    })
    .catch((err) => {
      activityLog.add(screenName, `Error reading image ${filename}`, err.message);
    });

  progress.tick();
};

const downloadSnapshot = async (screen, dir) => {
  let filename = `screen.png`;
  let screenName = screen.name;
  let url = screen.image.originalUrl;

  let slideFolderPath = `${dir}/${screenName}`;
  try {
    await fs.mkdir(slideFolderPath, { recursive: true });
  } catch (err) {}

  try {
    const { data } = await axios.get(url, { responseType: "stream" });
    await fs.writeFile(`${slideFolderPath}/${filename}`, data);
  } catch (err) {
    activityLog.add(screenName, `Error downloading snapshot ${filename}`, err.message);
  }
};

// metadata object to be saved to metadata.json
let metadata = {
  source: "zeplin",
  project: {
    id: null,
    name: null,
    screensCount: null,
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
              params: null,
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
  projectScreens: (screensCount) => {
    metadata.project.screensCount = screensCount;
  },
  screens: (screens) => {
    screens.forEach((screen) => {
      let template = JSON.parse(JSON.stringify(metadata.screens.template));
      template.id = screen.id;
      template.name = screen.name;
      metadata.screens.data.push(template);
    });
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
        activityLog.add(null, `Error: Unable to identify screen for layer ${layer.name}`, null);
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
          template.params = mF.assetNameAsParam(asset.displayName);
          template.filename = mF.assetFileName(template.params, asset.format, layerIndex);
          template.format = asset.format;
          template.density = asset.density;
          metadata.screens.data[screenIndex].layers.data[layerIndex].assets.data.push(template);
        } else {
          activityLog.add(metadata.screens.data[screenIndex].name, `Error: Unable to identify layer for asset ${asset.displayName}`, null);
        }
      } else {
        activityLog.add(null, `Error: Unable to identify screen for asset ${asset.displayName}`, null);
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
              metadata.screens.data[screenIndex].name,
              `Warning: rect dimensions for ${asset.filename} do not match actual file dimensions. Rect: ${layerWidth}x${layerHeight} Actual: ${width}x${height}`,
              null
            );
          }
        } else {
          activityLog.add(metadata.screens.data[screenIndex].name, `Error: Unable to identify asset for filename ${asset.filename}`, null);
        }
      } else {
        activityLog.add(metadata.screens.data[screenIndex].name, `Error: Unable to identify layer for asset with filename ${asset.filename}`, null);
      }
    } else {
      activityLog.add(null, `Error: Unable to identify screen asset with filename ${asset.filename}`, null);
    }
  },
  assetNameAsParam: (displayName) => {
    let nameAsArray;

    //split displayName using [] as delimiter
    if (displayName.includes("[")) {
      nameAsArray = displayName.split("[");
      nameAsArray = nameAsArray.map((part) => part.split("]"));
      nameAsArray = nameAsArray.flat();
    } else {
      nameAsArray = [];
    }

    nameAsArray = nameAsArray.filter((part) => part !== "");

    if (nameAsArray.length == 0) {
      return null;
    }

    //for each array item, turn "key:value" into object
    nameAsArray = nameAsArray.map((part) => {
      let obj = {};
      if (part.includes(":")) {
        let key = part.split(":")[0];
        let value = part.split(":")[1];
        obj[key] = value;
      } else {
        obj[part] = true;
      }
      return obj;
    });

    //turn array into object
    let nameAsObject = {};
    nameAsArray.forEach((part) => {
      let objKey = Object.keys(part)[0];
      let objValue = part[objKey];
      nameAsObject[objKey] = objValue;
    });

    return nameAsObject;
  },
  assetFileName: (params, format, layerIndex) => {
    if (params && params.id) {
      return `${params.id}.${format}`;
    } else {
      return `asset${layerIndex + 1}.${format}`;
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
          activityLog.add(screen.name, `Error parsing JSON for screen ${screen.name}`, err.message);
        }

        screen.config = configJSON;
      } else {
        activityLog.add(screen.name, `Error: Unable to find config layer for screen ${screen.name}`, null);
      }
    });
  },
  save: (folder, data) => {
    fs.writeFile(`${folder}/__metadata.json`, JSON.stringify(data, null, 2), (err) => {
      if (err) {
        activityLog.add(null, "Error: unable to save __metadata.json", err.message);
      }
    });
  },
  cleanUp: () => {
    delete metadata.screens.template;
  },
};

const activityLog = {
  data: [],
  add: (screenName, description, err) => {
    if (!screenName) screenName = "unknown";

    let screenIndex = activityLog.data.findIndex((screen) => screen.name === screenName);
    if (screenIndex == -1) {
      activityLog.data.push({ name: screenName, errors: [] });
      screenIndex = activityLog.data.length - 1;
    }
    activityLog.data[screenIndex].errors.push({ description, err });
  },
  save: (folder) => {
    activityLog.data.sort((a, b) => a.name.localeCompare(b.name));

    fs.writeFile(`${folder}/__log.txt`, JSON.stringify(activityLog.data, null, 2), (err) => {
      if (err) {
        activityLog.add(err.message);
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

    //project properties
    const { name: projectName, numberOfScreens: screensCount } = await getProjectProperties(projectId);
    mF.projectName(projectName);
    mF.projectScreens(screensCount);

    //output folder
    let desktopPath = path.join(process.env.HOME, "Desktop");
    let directory = path.join(desktopPath, metadata.project.name.replaceAll("/", "-") + "__assets");
    await fs.rm(directory, { recursive: true, force: true });
    await fs.mkdir(directory);

    //screens pagination loop
    let pageLimit = 30;
    let screensProcessed = 0;
    let totalScreens = screensCount;

    do {
      let batchSize = screensProcessed + pageLimit > totalScreens ? totalScreens : screensProcessed + pageLimit;

      console.log(`Processing screens ${screensProcessed} to ${batchSize} of ${screensCount}`);

      const screensBatch = await getProjectScreens(projectId, screenId, screensProcessed, pageLimit);
      mF.screens(screensBatch);

      const layers = await Promise.all(screensBatch.map(async (screen) => getLayersData(screen, projectId)));
      mF.layers(layers);

      const assets = await Promise.all(screensBatch.map(async (screen) => getAssetData(screen, projectId, formats, densities)));
      mF.assets(assets);

      //progress bar
      const assetsBar = new Progress("  Downloading project assets [:bar] :rate/bps :percent :etas", {
        complete: "=",
        incomplete: " ",
        width: 20,
        total: assets.flat().length,
      });

      //download assets
      if (!metadataOnly) {
        const assetsLimit = pLimit(20);
        const downloadAssetPromises = assets.flat().map((asset) => assetsLimit(() => downloadAsset(asset, directory, assetsBar)));
        await Promise.all(downloadAssetPromises);

        const snapshotsLimit = pLimit(20);
        const downloadSnapshotsPromises = screensBatch.flat().map((screen) => snapshotsLimit(() => downloadSnapshot(screen, directory)));
        await Promise.all(downloadSnapshotsPromises);
      }

      screensProcessed = screensProcessed + pageLimit < totalScreens ? screensProcessed + pageLimit : totalScreens - 1;
    } while (screensProcessed < totalScreens - 1);

    //parse screens config
    mF.config();

    //save metadata and log
    mF.cleanUp();
    mF.save(directory, metadata);

    activityLog.save(directory);
  });

program.parse(process.argv);
