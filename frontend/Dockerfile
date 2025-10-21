# Build stage
FROM node:20-alpine AS build
WORKDIR /app
ARG VITE_BASE=/
ARG VITE_BACKEND_URL=/api
ARG VITE_ANALYTICS_URL=/analytics
ENV VITE_BASE=$VITE_BASE VITE_BACKEND_URL=$VITE_BACKEND_URL VITE_ANALYTICS_URL=$VITE_ANALYTICS_URL
COPY package*.json ./
RUN npm ci
COPY . .
RUN npm run build

# Runtime stage
FROM nginx:1.25-alpine
ENV BACKEND_SERVICE_HOST=backend \
    BACKEND_SERVICE_PORT=8000 \
    ANALYTICS_SERVICE_HOST=analytics \
    ANALYTICS_SERVICE_PORT=8000 \
    ANALYTICS_SERVICE_PATH=/analytics/
COPY --from=build /app/dist /usr/share/nginx/html
COPY nginx.conf /etc/nginx/templates/default.conf.template