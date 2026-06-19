# gokturk-sim

# Installation

first install docker
pull docker image: 
```
docker pull radarku/ardupilot-sitl
```

run docker image: 
```
docker run -it --rm \
  --platform linux/amd64 \
  -p 5760:5760 \
  -p 14550:14550/udp \
  -p 14551:14551/udp \
  radarku/ardupilot-sitl
```