Useful PM2 Commands
Stop the server: pm2 stop streampi

Restart the server: pm2 restart streampi

See logs (for debugging): pm2 logs streampi

Remove from startup: pm2 delete streampi then pm2 save


# Transcoding
1. Do local transcoding job if the video is already in h264 and audio in acc but container is different.
2. Proiritize the container to delegate the transcoding job based on its avaiblality, cpu cores or gpu transcoding support, current cpu and ram uses, internet speed.


# transcoder node
1. UI for see current tasks and its progress, settings

# nas node
1. UI for its uses and and free spaces, settings
2. create users and api keys for user to use api
