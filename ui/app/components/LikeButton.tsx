import type { Cid, ResourceUri } from "@atcute/lexicons";
import { Trans } from "@lingui/react/macro";
import { ActionIcon, ActionIconProps, Tooltip } from "@mantine/core";
import { IconHeart, IconHeartFilled } from "@tabler/icons-react";
import { useCallback, useEffect, useState } from "react";
import { useClient } from "~/hooks";

export default function LikeButton({
  uri,
  cid,
  initialLike,
  setLikeState,
  size,
  iconSize,
}: {
  uri: ResourceUri;
  cid: Cid;
  initialLike: ResourceUri | null;
  setLikeState?: (v: boolean) => void;
  size?: ActionIconProps["size"];
  iconSize?: number;
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
          const r = await client.like(uri, cid);
          setLikeUri(r!);
        } finally {
          setPending(false);
        }
      } else if (!expectedOn && likeUri != null) {
        setPending(true);
        try {
          await client.unlike(likeUri);
          setLikeUri(null);
        } finally {
          setPending(false);
        }
      }
    })();
  }, [expectedOn, likeUri, client, uri, cid, pending]);

  iconSize = iconSize ?? 16;

  return (
    <Tooltip
      label={
        expectedOn ? <Trans>Attending</Trans> : <Trans>Not attending</Trans>
      }
    >
      <ActionIcon
        color={expectedOn ? "red" : "dimmed"}
        variant="transparent"
        size={size}
        onClick={handleClick}
      >
        {expectedOn ? (
          <IconHeartFilled size={iconSize} />
        ) : (
          <IconHeart size={iconSize} />
        )}
      </ActionIcon>
    </Tooltip>
  );
}
