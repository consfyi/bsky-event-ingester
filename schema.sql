CREATE TABLE labels (
    seq BIGSERIAL PRIMARY KEY,
    val TEXT NOT NULL,
    uri TEXT NOT NULL,
    neg BOOLEAN NOT NULL DEFAULT FALSE,
    payload BYTEA NOT NULL,
    like_rkey TEXT NOT NULL
);

CREATE INDEX labels_uri ON labels (uri);

CREATE INDEX labels_like_rkey ON labels (like_rkey)
WHERE
    NOT neg;

CREATE TABLE jetstream_cursor (cursor BIGINT NOT NULL);

CREATE UNIQUE INDEX jetstream_cursor_single_row ON jetstream_cursor ((true));
