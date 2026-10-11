# Control-glass UI candidate

Version 0.10.1 / Android code 17. Based on production main b4c7b11eb6e1409caa3d7caeadf47de40d979a59 (0.10.0 / code 16).

## Design

- Canvas #F5F6F8; text #20232A; secondary #626873; action #155AD8; urgent #B32E3D; rules #DCE0E5.
- Android controls at least 48px high; 24px standard gutter, 20px on narrow phones.
- Entry uses separate Boss and Staff control cards. Account access remains server-authoritative.
- Tickets use location/category above a clear title, then status and date. Overdue and follow-up dates retain distinct meaning.
- HQ keeps Active, Waiting and Done visible and all existing views in the selector.
- Staff and partner ticket search filters authorized in-memory rows only. It neither queries other stores nor persists a query across store/session reset.
- Navigation floats above a reserved bottom area. Short landscape lets the entire HQ screen scroll.
- Content surfaces and modal pages have no blur or background imagery. Only interactive controls and navigation use the frosted material.
- Reduced-transparency, unsupported-blur and reduced-motion fallbacks are provided. This release remains light-theme only.

## Release boundaries

There are no backend, SQL/RLS, credential, signing-key, application-ID or WebView-origin changes. The native surface/accent colors align with the new canvas. Release version checks are updated to 0.10.1/code17; signing behavior is unchanged.

See `design-qa.md` for the 0.10.1 browser acceptance, CI references and remaining physical-device/artifact gates. No screenshot from the 0.10.0 release is evidence of this new layout.
