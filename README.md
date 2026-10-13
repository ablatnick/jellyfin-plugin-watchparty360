# Watch Party for Jellyfin

![Watch Party](images/thumb.png)

Watch movies and shows with friends in sync, like the Xbox 360 watch parties. Everyone's avatar sits in a virtual theater in front of the screen. React, chat and talk while you watch. The host has the remote and everyone else follows along.

> **Requires Jellyfin 12.1 or newer.** It's built against Jellyfin 12.1, so servers on 10.11 or older can't install it. The theater, reactions, chat and voice need the Jellyfin web client.

> ❤️ Enjoying Watch Party? You can [support it on Venmo (@ablatnick)](https://venmo.com/u/ablatnick).

## Features

- **Synced playback.** Start a party from the 👥 button on any movie or episode. Invite friends, and they get a pop-up invite in the web client. The host's play, pause, seek and next episode are mirrored for everyone. A guest who drifts out of step is caught up automatically.
- **Virtual theater.**
  - The movie plays on a screen between red curtains, with up to 8 seats in front.
  - Everyone's avatar sits in a seat, seen from behind. When someone reacts (😂 👏 🎉 😮 😱 😢 ❤️ 👎 🍿), their avatar stands up, turns around and acts it out.
  - Chat shows as speech bubbles, and the house lights come up when the host pauses.
  - **⛶ Full screen movie** (or the `T` key) hides the theater; avatars then slide in from the corner.
- **Custom avatars.**
  - Pick skin tone, hairstyle and hair color, a top and its color, and extras like glasses, headphones, a party hat or a crown.
  - Use the cartoon face or your profile picture.
  - 🎲 *Surprise me* picks a random look.
- **Voice chat** in the browser. Your avatar's mouth moves while you talk, and the movie volume dips while someone else is talking.
- **Party controls.**
  - Guests can ✋ ask the host to pause, and the host can pass the remote to someone else.
  - Stepping away marks you "BRB", and **Rejoin** catches you up. When the host stops, everyone gets an intermission.
- **Play on any device.** The party can drive another of your devices, such as a TV app: accept the invite on your phone and watch on the TV. Any Jellyfin app that supports remote control follows the playback. The theater, reactions, chat and voice are web-client only.

| | |
|---|---|
| ![Theater](docs/theater-avatars.png) | ![Avatar editor](docs/avatar-editor.png) |
| ![Chat](docs/09-host-sees-chat.png) | ![Full screen](docs/10-fullscreen-pop.png) |

## Install

Requires **Jellyfin 12.1 or newer** (10.11 and older can't install it).

1. In Jellyfin, open **Dashboard → Plugins → Repositories (Catalog settings)** and add:

       https://raw.githubusercontent.com/ablatnick/jellyfin-plugin-watchparty360/main/manifest.json

2. Open the **Catalog**, find **Watch Party** under *General*, and install it.
3. Restart Jellyfin, then refresh any open browser tabs.

### Manual install

Download the zip from [Releases](https://github.com/ablatnick/jellyfin-plugin-watchparty360/releases). Extract it into `<jellyfin config>/plugins/WatchParty/` and restart Jellyfin.

## How to use

1. Open a movie or episode in the web client and press the 👥 button.
2. Tick the friends to invite (online people are listed first), choose which device to watch on, and press **Start party**.
3. Friends press **Join** on their invite. When everyone's in, press **▶ Start the movie**.
4. In the player, move the mouse to show the party buttons on the right edge: reactions, ✋ ask to pause, 💬 chat, 🎙 voice, the view switch, and 👥 the party panel.

## Settings

**Dashboard → Plugins → Watch Party**:

| Setting | Default | |
|---|---|---|
| Seats per party | 8 | Host included, 2–8 |
| Sync tolerance | 3 s | How far a guest may drift before being moved back in step |
| Voice chat servers | `stun:stun.l.google.com:19302` | STUN/TURN servers for voice chat, comma-separated |

## Voice chat notes

- **HTTPS is required.** Browsers only allow the microphone on https pages (or localhost). Over plain `http://<ip>:8096`, the voice button explains this instead of working.
- **Audio is peer to peer and encrypted.** By default it goes directly between browsers over WebRTC, which always encrypts it. Watch Party records nothing and stores no audio.
- **What other servers see.** Voice chat sets up connections through a few servers, and they see connection details but not your audio:
  - **Your Jellyfin server** passes the connection setup messages between browsers, so it sees each person's IP addresses. Watch Party doesn't log them.
  - **The STUN server** (by default Google's public `stun.l.google.com`) tells each browser its public IP address, so Google sees that IP address and when you connect.
  - **A TURN relay**, if you add one, carries the encrypted audio for people who can't connect directly. Its operator sees IP addresses and how much data flows, but can't decrypt the audio.

  To keep all of this in your own hands, run your own STUN/TURN server (e.g. [coturn](https://github.com/coturn/coturn)) and list only it, or leave the setting empty to only connect people on the same network.
- **STUN and TURN settings.** People behind strict NATs may not hear each other with STUN alone. A TURN relay fixes that: add it as `turn:user:password@host:3478`.
- **Headphones help.** They stop the movie audio from leaking into your mic.

## How it works

- **Playback sync.** The server watches the host's playback through Jellyfin's session events. It keeps guests in step with Jellyfin's built-in remote-control commands (play, pause, seek). The web client also reports its exact position every two seconds for tighter sync.
- **Script loading.** The web client script is added to `index.html` as the page is served. Nothing on disk is modified, so it works on read-only installs and leaves nothing behind when uninstalled. This needs Jellyfin to host its own web client (the default).
- **Storage.** Parties live in memory and end when the server restarts. Avatars are saved in `<data>/watchparty/avatars.json`.

## Building

    dotnet publish Jellyfin.Plugin.WatchParty -c Release -o out

Or, without a local .NET SDK:

    docker run --rm -v "$PWD":/src -w /src mcr.microsoft.com/dotnet/sdk:10.0 dotnet publish Jellyfin.Plugin.WatchParty -c Release -o out

Copy `out/Jellyfin.Plugin.WatchParty.dll` and `meta.json` into `<config>/plugins/WatchParty/`.

### Releasing

Push an annotated tag and GitHub Actions does the rest:

    git tag -a v1.0.0 -m "First release"
    git push origin v1.0.0

The workflow then:
- builds the plugin
- attaches `watchparty_1.0.0.0.zip` to a GitHub release
- adds the version to `manifest.json`, so Jellyfin servers that use the repository see the update

## Support

If Watch Party is useful to you, you can support it and other projects on [Venmo (@ablatnick)](https://venmo.com/u/ablatnick).

## License

[GPL-3.0](LICENSE), like Jellyfin.
