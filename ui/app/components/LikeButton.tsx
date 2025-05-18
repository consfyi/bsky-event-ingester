import { Trans } from "@lingui/react/macro";
import { ActionIcon, ActionIconProps, Tooltip } from "@mantine/core";
import { IconHeart, IconHeartFilled } from "@tabler/icons-react";

export default function LikeButton({
  isLiked,
  setIsLiked,
  size,
  iconSize,
}: {
  isLiked: boolean;
  setIsLiked: (v: boolean) => void;
  size?: ActionIconProps["size"];
  iconSize?: number;
}) {
  iconSize = iconSize ?? 16;

  return (
    <Tooltip
      label={isLiked ? <Trans>Attending</Trans> : <Trans>Not attending</Trans>}
    >
      <ActionIcon
        color={isLiked ? "red" : "dimmed"}
        variant="transparent"
        size={size}
        onClick={() => setIsLiked(!isLiked)}
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
