# STEM Smart Labs micro:bit Bluetooth Programmer

Static Web Bluetooth application for programming BBC micro:bit V2 MakeCode HEX files.

## Programming modes

The app chooses the programming method after reading the connected micro:bit:

- **Partial flash** when the HEX runtime hash and MakeCode program start match the installed runtime.
- **Full application Secure DFU** when the runtime or program layout differs, when no partial marker is available, or when only Buttonless DFU is exposed.

Full application DFU replaces the application region containing the CODAL/MakeCode runtime and user program. It preserves the SoftDevice and DFU bootloader.

## Full DFU workflow

1. Select a micro:bit V2 HEX.
2. Connect the normal `BBC micro:bit` device.
3. Click **Program over Bluetooth**.
4. Confirm the full application update when shown.
5. The micro:bit restarts into its Nordic bootloader.
6. Click **Select DFU device and continue**.
7. Choose **DfuTarg** in the browser Bluetooth chooser.
8. Keep the micro:bit powered until 100% completion.

The second chooser is required by Web Bluetooth because the bootloader appears as a separate Bluetooth device.

## What the browser prepares

For full DFU the browser performs all preparation locally:

- Extracts micro:bit V2 blocks `0x9903` and `0x9904` from Universal HEX files.
- Extracts the V2 application region `0x1C000` through the highest used address below `0x77000`.
- Fills Intel HEX gaps with `0xFF` and word-aligns the binary.
- Creates the 56-byte `microbit_app` V2 init packet.
- Adds the byte-reversed SHA-256 firmware digest when SubtleCrypto is available.
- Sends the init packet and application binary through Nordic Secure DFU.

No compiler service, MakeCode source extraction or runtime-specific recompilation is required.

## Local testing

```bash
npm test
npm run check
npm run serve
```

Open:

```text
http://localhost:8000
```

Use Chrome or Edge on a platform supporting Web Bluetooth. `localhost` is treated as a secure context.

## Important limitations

- micro:bit V2 only.
- The currently installed application must expose Buttonless DFU for a full wireless update.
- The newly installed HEX should retain Bluetooth/DFU support for future wireless updates. Otherwise USB recovery may be required.
- Browser and operating-system Bluetooth behaviour varies. Hardware testing is required before production use.
- Do not remove power during full DFU.

## Main files

- `core.js` — Universal/Intel HEX parsing, application extraction and V2 init packet.
- `dfu.js` — Buttonless DFU entry and Nordic Secure DFU transport.
- `app.js` — UI, automatic partial/full method selection and progress handling.
- `tests/` — parser, package and CRC tests.

See `THIRD_PARTY_NOTICES.md` for source attribution.
