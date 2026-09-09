## Website, webchat and provider channel adapters

**Feature:** F07-F08

This F00 directory only establishes the module boundary. No business behavior is implemented.
Future code is split into domain, application, infrastructure and presentation layers. Consumers
must import the public surface from index.ts; infrastructure details remain private.
