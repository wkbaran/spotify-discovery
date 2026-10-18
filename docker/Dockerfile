# Build stage: compile the job.
FROM node:26-alpine AS build
WORKDIR /app
COPY package.json package-lock.json tsconfig.json tsconfig.build.json ./
RUN npm ci
COPY src ./src
RUN npm run build

# Runtime: the job, its production dependencies (including spotify-discovery-mcp), and supercronic.
FROM node:26-alpine
RUN apk add --no-cache supercronic tzdata
ENV NODE_ENV=production
WORKDIR /app
COPY package.json package-lock.json ./
# The server is one bundled file with no runtime dependencies.
RUN npm ci --omit=dev --omit=optional && npm cache clean --force
COPY --from=build /app/dist ./dist
COPY docker/crontab ./crontab
# uid 1000, so files written to the bind-mounted state keep the owner they have.
USER node
CMD ["supercronic", "/app/crontab"]
