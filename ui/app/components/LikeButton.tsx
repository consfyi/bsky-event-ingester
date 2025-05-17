import type { ResourceUri, Cid } from "@atcute/lexicons";
import { Tooltip, ActionIcon, ActionIconProps } from "@mantine/core";
import { IconHeartFilled, IconHeart } from "@tabler/icons-react";
import { useState, useCallback, useEffect } from "react";
import { useClient } from "~/hooks";

export function LikeButton({
  uri,
  cid,
  initialLike,
  setLikeState,
  size,
}: {
  uri: ResourceUri;
  cid: Cid;
  initialLike: ResourceUri | null;
  setLikeState?: (v: boolean) => void;
  size?: ActionIconProps["size"];
}) {
  const client = useClient();

  const [likeUri, setLikeUri] = useState(initialLike);
  const [expectedOn, setExpectedOn] = useState(initialLike != null);
  const [pending, setPending] = useState(false);

  const handleClick = useCallback(() => {
    setExpectedOn(!expectedOn);
    if (setLikeState != null) {
      setLikeState(!expectedOn);
    }
  }, [setLikeState, expectedOn]);

  useEffect(() => {
    if (pending) return;

    (async () => {
      if (expectedOn && likeUri == null) {
        setPending(true);
        try {
          const r = await client!.like(uri, cid);
          setLikeUri(r!);
        } finally {
          setPending(false);
        }
      } else if (!expectedOn && likeUri != null) {
        setPending(true);
        try {
          await client!.unlike(likeUri);
          setLikeUri(null);
        } finally {
          setPending(false);
        }
      }
    })();
  }, [expectedOn, likeUri, client, uri, cid, pending]);

  return (
    <Tooltip label={expectedOn ? "Attending" : "Not attending"}>
      <ActionIcon
        color={expectedOn ? "red" : "dimmed"}
        variant="transparent"
        size={size}
        onClick={handleClick}
      >
        {expectedOn ? <IconHeartFilled size={16} /> : <IconHeart size={16} />}
      </ActionIcon>
    </Tooltip>
  );
}
