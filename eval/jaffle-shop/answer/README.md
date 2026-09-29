# Jaffle Shop answer ontology

`jaffle_shop.json` is the ontology an analytics agent should reach from `target/jaffle_shop.duckdb` alone. Compare a generated ontology to this file. Do not require identical ids or identical evidence prose.

## Warehouse identity

The RFC engine union is `bigquery` and `snowflake`. This fixture adds `duckdb`.

A table's identity is `(engine, path)`:

- `engine` is `duckdb`
- `path` is `schema.table` inside the database file, for example `main.orders` or `raw.raw_orders`

The file `target/jaffle_shop.duckdb` is the database. It is not part of the path. Views are recorded with `kind: "view"`. Semantic mappings do not point at views.

## What must match

- Domain ids and parent links. `jaffle_shop` has no tables. Child domains do not inherit membership.
- Membership: `main.customers` in `customers`; `main.orders` and `main.order_items` in `orders`; `main.products` and `main.supplies` in `catalog`; `main.locations` in `locations`; `main.metricflow_time_spine` in `calendar`.
- Every `raw.*` table and every `main.stg_*` view is present and unclassified (`domainIds` empty).
- Every column on those 19 objects, with the same name and data type.
- Seven terms: `customer`, `location`, `product`, `supply`, `order`, `order_item`, `calendar_day`. Each term belongs to the domain of its mart.
- Mappings from each term to every column of its mart, and to no other table. Primary keys and foreign keys use those roles. The foreign keys are `orders.customer_id`, `orders.location_id`, `order_items.order_id`, `order_items.product_id`, and `supplies.product_id`.
- Relations: `places`, `placed_at`, `contains`, `for_product`, `used_by`, and both `occurs_on` joins. The join expressions in the answer are the expected keys. `occurs_on` uses the calendar date of `ordered_at`.
- Constraints that preserve these rules:
  - Analyze from `main` marts. `raw.*` money columns are integer cents. Dollar amounts on `main.orders` are those cents divided by 100.
  - `orders.order_total = orders.subtotal + orders.tax_paid`.
  - `orders.order_items_subtotal = orders.subtotal`.
  - `customers.lifetime_spend = lifetime_spend_pretax + lifetime_tax_paid`.
  - `product_type` is only `jaffle` or `beverage`. `is_food_item` matches `jaffle`. `is_drink_item` matches `beverage`.
  - `customer_type` is only `new` or `returning`. `new` means `count_lifetime_orders = 1`. It is a status, not a kind of person.
  - `order_items.supply_cost` and `orders.order_cost` already sum supplies for the product. Do not add them again to `supplies.supply_cost`.
  - `metricflow_time_spine` is a calendar from 2000-01-01 through 2029-12-31, not a table of business events.
- Included records are `active: true` and `drifted: false`. Evidence uses `source: "revise"`.

## What may differ

Term definitions, constraint wording, evidence summaries, and generated ids may differ when the meaning above is intact.

## Misses

A result misses when it drops a mart column, maps a term onto `raw` or `stg_`, omits an unclassified source or staging object, drops a relation, or drops a money or double-count constraint.
