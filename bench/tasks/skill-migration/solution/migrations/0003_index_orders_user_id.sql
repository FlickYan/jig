-- migrate:up
CREATE INDEX ix_orders_user_id ON orders (user_id);

-- migrate:down
DROP INDEX ix_orders_user_id;
