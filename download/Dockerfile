FROM node:22-bookworm-slim

RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates curl ffmpeg python3 \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app
RUN mkdir bin \
  && curl -fsSL https://github.com/yt-dlp/yt-dlp-nightly-builds/releases/latest/download/yt-dlp -o bin/yt-dlp \
  && chmod 755 bin/yt-dlp \
  && chown -R node:node bin \
  && bin/yt-dlp --version

COPY --chown=node:node server.mjs ./server.mjs

USER node
ENV YTDLP_BINARY=/app/bin/yt-dlp
EXPOSE 8080
CMD ["node", "server.mjs"]
