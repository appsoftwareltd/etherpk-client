# Run build (from workspace root): docker build -f apps/client/Dockerfile --build-arg GIT_COMMIT=$(git rev-parse HEAD) -t etherpk-client .
# Must be run from the repository root so pnpm workspace resolution works.

# -- Stage 1: Build ---------------------------------------------------------
FROM node:22-alpine AS builder

WORKDIR /app

RUN corepack enable && corepack prepare pnpm@11.5.3 --activate

# Copy workspace root files first for install
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc ./

# Copy all workspace package.json files so pnpm can resolve the workspace. The two workspace
# packages the Client depends on come across whole, not just their package.json: both are
# consumed as TypeScript source, and packages/themes reads every theme file through
# import.meta.glob at build time (packages/themes/src/index.ts), so a package left out here
# passes `pnpm install` and then fails in `vite build` as an unresolvable import.
COPY apps/client/package.json apps/client/package.json
COPY packages/shared/ packages/shared/
COPY packages/themes/ packages/themes/

RUN pnpm install --frozen-lockfile

# Copy client app source
COPY apps/client/ apps/client/
# The one repository script the build runs; the rest of scripts/ is development tooling.
COPY scripts/prune-build-tooling.mjs scripts/prune-build-tooling.mjs

# The commit the image is built from, stamped into the top of every page source so a running
# deployment identifies itself (see packages/shared/src/build-stamp/build-stamp.ts). The build context
# excludes .git, so this argument is the only way the commit reaches the build.
ARG GIT_COMMIT=unknown
ENV GIT_COMMIT=$GIT_COMMIT

# Build-time only. docker/staging serves the Client over plain HTTP on *.localhost names, and the
# Content-Security-Policy is baked into the build, so that build must be told to allow http:/ws:
# connections to its Sync Server (see packages/shared/src/security/csp.ts). Never set it for a
# production image.
ARG PLAINTEXT_ORIGINS=false
ENV PLAINTEXT_ORIGINS=$PLAINTEXT_ORIGINS

# Build and deploy standalone. The prune drops the compilers and bundlers that `deploy --prod`
# materialises but the serving path never imports (662MB -> 552MB). It is a deliberate list, not
# something derivable - @sveltejs/kit really does depend on typescript - so what keeps it honest
# is the `bundle` job in .github/workflows/build.yaml, which runs this same script over this same
# deploy output and then boots it and serves a page. Do not remove that job without giving this
# line its own smoke test.
RUN pnpm --filter @appsoftwareltd/etherpk-client build \
    && pnpm --filter @appsoftwareltd/etherpk-client deploy --prod /app/deploy \
    && node scripts/prune-build-tooling.mjs /app/deploy

# -- Stage 2: Runtime -------------------------------------------------------
FROM node:22-alpine

WORKDIR /app

COPY --chown=node:node --from=builder /app/apps/client/build ./build
COPY --chown=node:node --from=builder /app/deploy/node_modules ./node_modules
COPY --chown=node:node --from=builder /app/deploy/package.json ./package.json
# The Elastic License 2.0 travels with the image, so whoever pulls it has the terms it is under.
COPY --chown=node:node LICENSE ./LICENSE

ENV NODE_ENV=production
ENV PORT=3000

EXPOSE 3000

USER node

CMD ["node", "build"]
