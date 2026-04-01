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

# Copy only what user-service needs
COPY apps/user-service/ ./apps/user-service/

# Prisma schema and migrations need to be copied separately to ensure they are available for development and not accidentally left out.
COPY apps/user-service/prisma/ ./apps/user-service/prisma/

EXPOSE 3002
CMD ["dumb-init", "node", "node_modules/.bin/nest", "start", "user-service", "--watch"]

# ============================================================
# STAGE 3 — BUILD
# ============================================================
# This stage compiles the TypeScript code and prepares the production build, including pruning development dependencies.
FROM base AS build

# Install build dependencies
ENV NODE_ENV=prod
RUN npm ci

# Copy only what user-service needs
COPY apps/user-service/ ./apps/user-service/
COPY apps/user-service/prisma/ ./apps/user-service/prisma/

# Generate Prisma schema
RUN npx prisma generate --schema=apps/user-service/prisma/schema.prisma

# Build only user-service, not all services
RUN node_modules/.bin/nest build user-service

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
COPY --from=build /usr/src/app/apps/user-service/prisma ./prisma

# Set ownership to the non-root user
USER nodejs
EXPOSE 3002
CMD ["dumb-init", "node", "dist/apps/user-service/main.js"]
