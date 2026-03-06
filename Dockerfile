FROM node:20-alpine

WORKDIR /app

COPY package.json ./
RUN npm install --production

COPY . .

RUN mkdir -p /app/data

EXPOSE 3200

ENV NODE_ENV=production
ENV PORT=3200

CMD ["node", "server.js"]
