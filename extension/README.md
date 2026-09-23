# Candidate Compass — Connect Ashby (Chrome extension)

One click to connect your Ashby login to Candidate Compass. Ashby's session
cookie is HttpOnly, so a web page cannot read it; this extension can (with the
`cookies` permission) and hands it to the Compass page you are signed in to,
which sends it to the extractor under **your** account. Nothing is stored in
the extension and the cookie never goes anywhere else.

Install (unlisted / developer mode): `chrome://extensions` → Developer mode →
Load unpacked → this folder. Or distribute via Google Workspace policy.

Update the Compass hostname in `manifest.json` (`content_scripts.matches`) and
`popup.js` if the app moves.

Weekly re-connect is an Ashby limit (logins expire ~7 days); this only makes it
a single click instead of a DevTools trip.
