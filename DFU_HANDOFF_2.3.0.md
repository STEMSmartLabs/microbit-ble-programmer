# DFU handoff 2.3.0

This update is layered on top of the proven v2.2.9 Secure DFU transfer.

- Reuses the originally permitted micro:bit BluetoothDevice for the first bootloader connection attempt.
- Automatically starts that attempt when the post-Buttonless-DFU selector becomes ready.
- Avoids ambiguity when several nearby boards advertise as `DfuTarg`.
- Falls back to the normal manual DfuTarg chooser only when automatic reconnection fails.
- Keeps the v2.2.9 pairing split, Packet Receipt Notifications, packet pacing, CRC validation, resume handling and tail recovery unchanged.
- Does not rely on a device name, raw Bluetooth address or operating system.

When manual selection is required and multiple `DfuTarg` devices are nearby, isolate the target board by powering off or moving the others away.
