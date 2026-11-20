# keyboard-pic-scraper

![image](image.png)

First, install dependencies:

```bash
npm ci
```

Then run:

```bash
npm start
```

The scraper checks immediately, then waits 60 seconds between checks. If the first listing has the same image URL as the last successful upload, it skips both the image download and the upload. Failed attempts are logged and retried on the next check. `SIGTERM` (including `docker stop`) and `SIGINT` stop the loop.

After a successful upload, the scraper sets `LAST_IMAGE_URL` in its running process environment. Nothing is written to disk, so by default the first image is uploaded again after a restart.

The scraper accepts JPEG and PNG listing images. PureImage measures the price text and scales it proportionally so its width, including the white outline, matches the image's shorter side. If the text would be too tall, it scales down to fit the image height instead. The red price stays centered, and the scraper uploads the result as a JPEG at quality 90. The `slkscr.ttf` font is bundled; no system font installation is required.

### Docker

```bash
winget install -e --id Docker.DockerCLI
# winget install -e --id Docker.Buildx
docker context create minion --docker "host=ssh://harr@minion.local"
docker --context minion build --platform linux/amd64 -t keyboard-pic-scraper .
ssh harr@minion.local
docker stop scraper && docker rm scraper
docker run -d --name scraper -e UPLOAD_URL="http://192.168.0.111/api/image?fit=cover" ghcr.io/ZalaPanda/keyboard-pic-scraper:latest
```

Replace the example IP with your display's IP or a hostname resolvable from inside the container. The default is `esp32-display.local`, but Docker may not resolve `.local` names. Set `UPLOAD_URL` to change the upload endpoint or `POLL_INTERVAL_MS` to change the delay between checks.

To check JavaScript syntax:

```bash
npm run check
```
