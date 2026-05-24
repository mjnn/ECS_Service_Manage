FROM docker.m.daocloud.io/library/node:20-alpine

WORKDIR /app

COPY package.json ./
RUN npm install --omit=dev

COPY . .

EXPOSE 3000

CMD ["npm", "start"]
