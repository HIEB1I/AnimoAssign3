# Build stage
FROM node:20-alpine AS build
WORKDIR /app
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