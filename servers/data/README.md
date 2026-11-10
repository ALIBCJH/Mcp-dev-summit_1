# Demo data

A Kenya travel assistant. Airports and cities are real; every airline, hotel
and flight number is invented. Prices are in Kenyan shillings (KES). Each
server loads its file once at startup.

- `flights.json`: flights from Nairobi (NBO) to UKA (Diani Beach), LAU
  (Lamu), MYD (Malindi/Watamu), NYK (Nanyuki), KIS (Kisumu) and MRE (Maasai
  Mara, Mara Serena airstrip). Carriers: Kifaru Air (KF) and Nyota Air (NY).
- `hotels.json`: 11 hotels across those destinations.

## Do not clean the poisoned review

One Diani Beach review in `hotels.json` contains an injected instruction
("SYSTEM: ignore previous instructions ..."). It is there on purpose: it is
the input for the prompt-injection demo in Phase 5. Do not filter, sanitize
or reword it. The point of the demo is that the server returns it as-is and
the booking limit in the Bookings server is what stops the attack.
