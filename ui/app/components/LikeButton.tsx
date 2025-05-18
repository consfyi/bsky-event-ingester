import type { Cid, ResourceUri } from "@atcute/lexicons";
import { Trans } from "@lingui/react/macro";
import { ActionIcon, ActionIconProps, Tooltip } from "@mantine/core";
import { IconHeart, IconHeartFilled } from "@tabler/icons-react";
import { useEffect, useState } from "react";
import { useClient } from "~/hooks";

export default function LikeButton({
  uri,
  cid,
  initialLike,
  isLiked,
  setIsLiked,
  size,
  iconSize,
}: {
  uri: ResourceUri;
  cid: Cid;
  initialLike: ResourceUri | null;
  isLiked: boolean;
  setIsLiked: React.Dispatch<React.SetStateAction<boolean>>;
  size?: ActionIconProps["size"];
  iconSize?: number;
}) {
  const client = useClient();

  const [likeUri, setLikeUri] = useState(initialLike);
  const [pending, setPending] = useState(false);

  useEffect(() => {
    if (pending) return;

    (async () => {
      if (isLiked && likeUri == null) {
        setPending(true);
        try {
          const r = await client.like(uri, cid);
          setLikeUri(r!);
        } finally {
          setPending(false);
        }
      } else if (!isLiked && likeUri != null) {
        setPending(true);
        try {
          await client.unlike(likeUri);
          setLikeUri(null);
        } finally {
          setPending(false);
        }
      }
    })();
  }, [isLiked, likeUri, client, uri, cid, pending]);

  iconSize = iconSize ?? 16;

  return (
    <Tooltip
      label={isLiked ? <Trans>Attending</Trans> : <Trans>Not attending</Trans>}
    >
      <ActionIcon
        color={isLiked ? "red" : "dimmed"}
        variant="transparent"
        size={size}
        onClick={() => setIsLiked((isLiked) => !isLiked)}
      >
        {isLiked ? (
          <IconHeartFilled size={iconSize} />
        ) : (
          <IconHeart size={iconSize} />
        )}
      </ActionIcon>
    </Tooltip>
  );
}
