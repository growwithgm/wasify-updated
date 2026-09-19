# Wasify theme app extension

This folder is the Shopify **theme app extension** that puts the WhatsApp
opt-in popup on the storefront as an **app embed** — the merchant switches it
on in the theme customizer, no liquid pasting, and it survives theme updates.

The extension deliberately contains **no content and no rules**. Its only job
is to load one small JS file; everything else (texts, consent wording, page
targeting, trigger, frequency, discount) comes from the Wasify admin through
the App Proxy config endpoint on every page load. Editing the popup in the
admin is live immediately — deploying this extension again is only needed
when the JS itself changes.

## One-time setup (run from the repository root)

```bash
npm install -g @shopify/cli@latest

# Links this repo to the existing "Wasify Super DC" app. This DOWNLOADS the
# app's current configuration from the Partner Dashboard into
# shopify.app.toml — run it BEFORE the first deploy so the deploy cannot
# overwrite dashboard settings with an empty file.
shopify app config link

# Bundles extensions/ + the linked config into a new app version and
# releases it.
shopify app deploy
```

After a successful deploy: **Online Store → Themes → Customize → App embeds →
Wasify WhatsApp Popup → toggle ON → Save.**

If you later change app settings in the Partner Dashboard (redirect URLs,
proxy, scopes), run `shopify app config link` again before the next
`shopify app deploy`, so the deploy carries the current configuration.
