FROM node:22-bookworm-slim

WORKDIR /app
ENV NODE_ENV=development

COPY package.json package-lock.json ./
RUN npm ci

COPY . .
RUN npm run build

EXPOSE 3000 5173 8545
CMD ["npm", "run", "local:backend"]
