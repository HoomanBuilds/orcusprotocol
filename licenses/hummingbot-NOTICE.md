# Hummingbot lifecycle adaptation

Copyright 2023 Hummingbot Foundation.

Portions of `agent/src/venues/hyperliquid/lifecycle.ts` are adapted from Hummingbot, revision `9af100d6822da7d2d0291a906c730ef172284ee2`:

- `hummingbot/connector/derivative/hyperliquid_perpetual/hyperliquid_perpetual_constants.py`: explicit order-state table.
- `hummingbot/connector/derivative/hyperliquid_perpetual/hyperliquid_perpetual_derivative.py`: order-scoped fill correlation and execution evidence.
- `hummingbot/core/data_type/in_flight_order.py`: duplicate trade-ID suppression before accumulating fills.

Source: https://github.com/hummingbot/hummingbot/tree/9af100d6822da7d2d0291a906c730ef172284ee2

Licensed under Apache-2.0; the full license is in `hummingbot-LICENSE.txt`. No upstream NOTICE file was present at this revision.

Modifications: translated the selected lifecycle behavior into TypeScript, retained exact integer-based quantities, added the current installed Hyperliquid SDK's documented processing states, rejected unknown statuses, bounded fill processing, and kept cancellation status separate from any previously executed fills. Wallet loading, signing, builder fees and the Hummingbot runtime are not included.
