# ============================================================
# STAGE 1 — BASE STAGE
# ============================================================
# This stage sets up the base image and common dependencies for both development and production stages.
FROM node:24-alpine AS base

# Create app directory
WORKDIR /usr/src/app

# Install common dependencies
RUN apk add --no-cache dumb-init

# Copy package files
COPY package*.json ./
COPY nest-cli.json ./
COPY tsconfig.json ./

# Copy the shared lib — every service depends on it
COPY libs/ ./libs/

# ============================================================
# STAGE 2 — DEVELOPMENT 
# ============================================================
# This stage is optimized for development with hot-reloading and development dependencies.
FROM base AS development

# Install development dependencies
ENV NODE_ENV=dev
RUN npm ci

# Copy only what report-service needs
COPY apps/report-service/ ./apps/report-service/

# Prisma schema and migrations need to be copied separately to ensure they are available for development and not accidentally left out.
COPY apps/report-service/prisma/ ./apps/report-service/prisma/

EXPOSE 3003
CMD ["dumb-init", "node", "node_modules/.bin/nest", "start", "report-service", "--watch"]

# ============================================================
# STAGE 3 — BUILD
# ============================================================
# This stage compiles the TypeScript code and prepares the production build, including pruning development dependencies.
FROM base AS build

# Install build dependencies
ENV NODE_ENV=prod
RUN npm ci

# Copy only what report-service needs
COPY apps/report-service/ ./apps/report-service/
COPY apps/report-service/prisma/ ./apps/report-service/prisma/

# Generate Prisma schema
RUN npx prisma generate --schema=apps/report-service/prisma/schema.prisma

# Build only report-service, not all services
RUN node_modules/.bin/nest build report-service

# Remove dev dependencies
RUN npm prune --production


# ============================================================
# STAGE 4 — PRODUCTION
# ============================================================
# This stage is optimized for production with only the necessary files and dependencies, and runs the compiled code.
FROM node:24-alpine AS production

# Create app directory
ENV NODE_ENV=prod
WORKDIR /app

# Install common dependencies
RUN apk add --no-cache dumb-init && \
    addgroup -g 1001 -S nodejs && \
    adduser -S nestjs -u 1001

# Copy only the built files and production dependencies from the build stage
COPY --from=build /usr/src/app/dist              ./dist
COPY --from=build /usr/src/app/node_modules      ./node_modules
COPY --from=build /usr/src/app/apps/report-service/prisma ./prisma

# Set ownership to the non-root user
USER nodejs
EXPOSE 3003
CMD ["dumb-init", "node", "dist/apps/report-service/main.js"]
