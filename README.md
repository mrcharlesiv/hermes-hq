# Hermes HQ

Hermes HQ is an iPhone app for [Hermes](https://hermes-agent.nousresearch.com/). This repository holds the small tool
that lets Hermes HQ reach the computer running Hermes **from anywhere**. You sign in with your Nous account, and your
phone doesn't need Tailscale or a VPN.

## Set it up

**Easiest: let Hermes do it.** In Hermes HQ, tap **Get Started** and send your Hermes the message the app gives you
(Telegram, Discord, the Hermes app or its terminal all work). Hermes runs this setup on its own computer with
`--agent`, which never waits on a prompt: anything only you can do, like signing in to Nous or allowing Funnel, comes
back to you as a link or one short instruction. When it's done, Hermes sends you an address to paste into Hermes HQ;
then tap **Sign in with Nous**.

To run it yourself instead:

It works on a Mac or on Linux: a server, a VPS or a box at home, at its own terminal or over SSH. (For Hermes on
Windows, open Hermes HQ, tap **Get Started** and choose **On Windows**: it uses Tailscale on your phone instead.)

On the computer where Hermes runs, open a terminal (on a Mac: press ⌘ Space, type Terminal, press Return) and paste:

```sh
curl -fsSL https://raw.githubusercontent.com/mrcharlesiv/hermes-hq/main/connect.sh | sh
```

It checks what's needed and does it for you. If Hermes isn't running, it starts it in the background, and again
whenever you log in or the computer starts. It only stops when you have to do something:

1. **Sign in to Nous** in your browser, if Hermes on this computer isn't signed in already. On a computer without a
   screen it shows a link and a code: open the link in any browser, even your phone's.
2. **Install Tailscale on this computer and sign in.** Not on your phone. Tailscale gives the computer a secure
   public address.
3. **Turn on MagicDNS and HTTPS Certificates** in Tailscale's admin page. It gives you the link.
4. **Click Allow** if Tailscale asks you to allow Funnel, its public-address feature, for this computer.
5. **On Linux, your password once (sudo)**, if the system asks: so Hermes and the gatekeeper keep running after you
   log out, and so your account may manage Tailscale.

When it's done, it shows a **QR code**. Point your iPhone's Camera at it and tap **Open in Hermes HQ**. Hermes HQ
opens with your computer's address filled in. Tap **Sign in with Nous**, and you're connected.

You can run the same command again at any time. If everything is already set up, it changes nothing. Keep the
computer on (and a Mac awake): your iPhone can reach Hermes only while it is.

**Set up before the app was called Hermes HQ?** Run the command again. It moves your setup over to the new names and
keeps the Nous accounts you allowed, your public address and your sign-ins. The address drops for a second or two
while the new gatekeeper takes over from the old one.

## Turn it off

```sh
curl -fsSL https://raw.githubusercontent.com/mrcharlesiv/hermes-hq/main/connect.sh | sh -s -- off
```

That closes the public address, stops the gatekeeper, and stops Hermes running in the background if this setup
started it. Check what's on with `sh -s -- status`. For an agent (or a script), add `--agent`: each run ends in DONE
with the address, or a NEXT STEP (exit code 3) saying what to do before running it again. To see what setup
would change without changing anything, use `sh -s -- --dry-run`.

## What it does, and why it's safe

- **Only your Nous account gets in.** A small gatekeeper (`connect/hermes-hq-edge.mjs`) runs on your computer, in
  front of Hermes. It lets in only the Nous account that Hermes on this computer is signed in to. Anyone else who
  finds the address gets nothing: not your chats, files or settings, and they can't run tools.
- **No password on the internet.** If Hermes also has a username and password sign-in, the gatekeeper keeps it off
  the public address.
- **Hermes still checks every request itself.** The gatekeeper only narrows what reaches Hermes.
- **Your chats go only to your computer.** Nous handles the sign-in; your messages never pass through Nous.
- **Nothing secret is written to logs**, and Hermes HQ keeps your session in the iPhone's Keychain.

Requirements: a Mac, or Linux with systemd, with Hermes installed; a free Nous account; and a free Tailscale account
for that computer. Your phone needs only Hermes HQ.

## Files

- `connect.sh` downloads `connect/` into `~/.config/hermes-hq-edge/connect` and runs it with Node (the Node that
  Hermes includes works).
- `connect/hermes-hq-connect.mjs` is the setup command: `setup` (the default), `status`, `off`, `--dry-run`.
- `connect/hermes-hq-edge.mjs` is the gatekeeper. It runs as the `com.hermes-hq.edge` LaunchAgent on a Mac, or the
  `hermes-hq-edge.service` systemd user service on Linux, and listens only on this computer. (Mac setups from before
  the rename used `com.dispatch.edge` and `~/.config/dispatch-edge`; setup moves them over and leaves the old folder
  in place.)
- If no Hermes backend is running, setup starts `hermes serve` as the `com.hermes-hq.hermes` LaunchAgent, or the
  `hermes-hq-hermes.service` user service on Linux: Hermes's own command and arguments, so `hermes update` restarts
  it. Its log is `~/.config/hermes-hq-edge/hermes.log`.
- `connect/qr.mjs` draws the QR code in the terminal.
- `connect/test/` holds the tests: `node --test connect/test/*.test.mjs`.

MIT licensed.
