CREATE TABLE labels (
    seq BIGSERIAL PRIMARY KEY,
    cts TIMESTAMPTZ NOT NULL,
    exp TIMESTAMPTZ,
    cid TEXT,
    sig BYTEA,
    uri TEXT NOT NULL,
    val TEXT NOT NULL,
    neg BOOLEAN NOT NULL DEFAULT FALSE,
    like_rkey TEXT NOT NULL
);

CREATE INDEX labels_uri ON labels (uri);

CREATE INDEX labels_like_rkey ON labels (like_rkey)
WHERE
    NOT neg;

CREATE TABLE jetstream_cursor (cursor BIGINT NOT NULL);

CREATE UNIQUE INDEX jetstream_cursor_single_row ON jetstream_cursor ((true));
