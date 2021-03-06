import { createFilter } from "@rollup/pluginutils";
import MagicString from "magic-string";
import path from "path";
import sharp, { Sharp } from "sharp";
import { Plugin, ResolvedConfig } from "vite";

import { Options } from "./types";

const ID_PREFIX = "/@sharp-resize";

interface GeneratedImage {
  image: Sharp;
  extension: string;
}

export function pluginSharp(options: Options): Plugin {
  options.include =
    options.include ?? "**/*.{heic,heif,avif,jpeg,jpg,png,tiff,webp,gif}";
  const filter = createFilter(options.include, options.exclude);

  const generatedImages = new Map<string, GeneratedImage>();

  let userConfig: ResolvedConfig;

  return {
    name: "sharp-resize",
    enforce: "pre",
    configResolved(config) {
      userConfig = config;
    },
    async load(id) {
      if (!filter(id)) return null;

      // run sharp
      let image = sharp(id).resize(options.resize);
      if (options.withMetadata) image = image.withMetadata();
      if (options.outputFileType?.type) {
        image = image[options.outputFileType.type](
          // @ts-ignore
          options.outputFileType.options
        );
      }
      const extension = options.outputFileType?.type ?? path.extname(id);

      // cache image in map for dev server
      generatedImages.set(id, {
        image,
        extension,
      });

      let outputId: string;
      if (!this.meta.watchMode) {
        const fileHandle = this.emitFile({
          name: `${path.basename(id)}.${extension}`,
          source: await image.toBuffer(),
          type: "asset",
        });

        outputId = `__VITE_IMAGE_ASSET__${fileHandle}__`;
      } else {
        outputId = path.join(ID_PREFIX, id);
      }

      return `export default ${JSON.stringify(outputId)}`;
    },
    configureServer(server) {
      server.middlewares.use(async ({ url }, res, next) => {
        if (url?.startsWith(ID_PREFIX)) {
          const [, id] = url.split(ID_PREFIX);

          // serve image from dev server
          const imageData = generatedImages.get(id);

          if (!imageData)
            throw new Error(
              `sharp-resize cannot find image with id "${id}" this is likely an internal error`
            );

          const { image, extension } = imageData;

          res.setHeader("Content-Type", `image/${extension}`);
          res.setHeader("Cache-Control", "max-age=360000");
          return image.clone().pipe(res);
        }

        next();
      });
    },
    renderChunk(code) {
      const assetUrlRE = /__VITE_IMAGE_ASSET__([a-z\d]{8})__(?:_(.*?)__)?/g;

      let match;
      let s;
      while ((match = assetUrlRE.exec(code))) {
        s = s || (s = new MagicString(code));
        const [full, hash, postfix = ""] = match;

        const file = this.getFileName(hash);

        const outputFilepath = userConfig.base + file + postfix;

        s.overwrite(match.index, match.index + full.length, outputFilepath);
      }

      if (s) {
        return {
          code: s.toString(),
          map: userConfig.build.sourcemap
            ? s.generateMap({ hires: true })
            : null,
        };
      } else {
        return null;
      }
    },
  };
}
