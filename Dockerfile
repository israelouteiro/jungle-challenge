FROM oven/bun:1.4.4 AS benchmark
WORKDIR /app
COPY test/load/install-oha.ts test/load/oha-release.ts test/load/download-oha.ts ./test/load/
RUN bun test/load/install-oha.ts && .tools/oha-1.16.0 --version

FROM oven/bun:1.4.4 AS build
WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile
COPY tsconfig.json apidoc.json ./
COPY docs ./docs
COPY src ./src
RUN bun run build

FROM build AS tools
COPY --from=benchmark /app/.tools ./.tools
COPY . .
CMD ["bun", "run", "test:all"]

FROM oven/bun:1.4.4 AS runtime
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build /app/package.json /app/bun.lock ./
RUN bun install --frozen-lockfile --production
COPY --from=build /app/dist ./dist
RUN mkdir -p /app/.snapshots && chown bun:bun /app/.snapshots
USER bun
EXPOSE 3000
CMD ["bun", "dist/main.js"]
