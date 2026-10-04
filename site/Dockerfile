# Soundwave AI — sales site
#
# Static files plus a tiny Node process that only exists to create Stripe
# Checkout Sessions. Build it and run it anywhere Node runs.
#
#   docker build -t soundwave-site .
#   docker run -p 4173:4173 --env-file .env soundwave-site
#
# (Or skip Node entirely: upload the folder to any static host and paste Stripe
#  Payment Links into config.js — the site works without this server.)

FROM node:22-alpine

WORKDIR /app

# The site has no dependencies — just copy it in.
COPY . .

ENV NODE_ENV=production
ENV PORT=4173
ENV HOST=0.0.0.0

# Runs as the unprivileged node user that the base image already provides.
USER node

EXPOSE 4173

HEALTHCHECK --interval=30s --timeout=3s --start-period=5s \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||4173)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "server.mjs"]
