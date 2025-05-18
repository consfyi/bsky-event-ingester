import { Trans } from "@lingui/react/macro";
import { ActionIcon, ActionIconProps, Tooltip } from "@mantine/core";
import { IconHeart, IconHeartFilled } from "@tabler/icons-react";
import { useLocalAttending } from "./LocalAttendingContextProvider";

export default function LikeButton({
  conId,
  size,
  iconSize,
}: {
  conId: string;
  size?: ActionIconProps["size"];
  iconSize?: number;
}) {
  iconSize = iconSize ?? 16;

  const { isAttending, setIsAttending } = useLocalAttending(conId);

  return (
    <Tooltip
      label={
        isAttending ? <Trans>Attending</Trans> : <Trans>Not attending</Trans>
      }
    >
      <ActionIcon
        color={isAttending ? "red" : "dimmed"}
        variant="transparent"
        size={size}
        onClick={() => setIsAttending(!isAttending)}
      >
        {isAttending ? (
          <IconHeartFilled size={iconSize} />
        ) : (
          <IconHeart size={iconSize} />
        )}
      </ActionIcon>
    </Tooltip>
  );
}
