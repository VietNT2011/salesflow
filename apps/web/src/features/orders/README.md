## orders

F03 provides `/orders` for the visible CRM order list, manual order entry and Owner/Admin product
catalog settings. `/orders/:orderId` shows immutable line snapshots, server totals and allowed status
commands. Customer 360 reuses the same API for its Orders tab and reads immutable order events for the
Timeline tab. Permissions remain enforced by the API; hiding controls is only a UI convenience.
