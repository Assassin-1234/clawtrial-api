# ClawTrial API Dockerfile
# Multi-stage build for production optimization

# Stage 1: Dependencies
FROM node:18-alpine AS deps
RUN apk add --no-cache libc6-compat
WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm ci --only=production

# Stage 2: Builder
FROM node:18-alpine AS builder
WORKDIR /app

COPY --from=deps /app/node_modules ./node_modules
COPY . .

# Stage 3: Runner
FROM node:18-alpine AS runner
WORKDIR /app

ENV NODE_ENV=production
ENV PORT=3000

RUN addgroup --system --gid 1001 nodejs
RUN adduser --system --uid 1001 clawtrial

# Copy necessary files
COPY --from=builder --chown=clawtrial:nodejs /app/node_modules ./node_modules
COPY --from=builder --chown=clawtrial:nodejs /app/src ./src
COPY --from=builder --chown=clawtrial:nodejs /app/package.json ./package.json

# Create logs directory
RUN mkdir -p logs && chown clawtrial:nodejs logs

USER clawtrial

EXPOSE 3000

ENV ENABLE_CLUSTERING=true

CMD ["node", "src/server.js"]
