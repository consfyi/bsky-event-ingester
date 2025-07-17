import { Box, useComputedColorScheme, useMantineTheme } from "@mantine/core";
import { IconMapPinFilled } from "@tabler/icons-react";
import { getDay } from "date-fns";
import { RMap, RMarker, RPopup } from "maplibre-react-components";
import "maplibre-theme/icons.default.css";
import "maplibre-theme/modern.css";
import { useState } from "react";
import { ConWithPost } from "~/hooks";
import { ConRow } from "./ConsList";
import lightStyle from "./Map/styles/light.json?url";
import darkStyle from "./Map/styles/dark.json?url";

function Pin({
  con,
  showPopup,
  onClick,
}: {
  con: ConWithPost;
  showPopup: boolean;
  onClick?(e: MouseEvent): void;
}) {
  const theme = useMantineTheme();

  const rawLatLng = con.geocoded?.latLng;
  if (rawLatLng == null) {
    return null;
  }
  const [rawLat, rawLng] = rawLatLng;
  const lat = parseFloat(rawLat);
  const lng = parseFloat(rawLng);

  const color = [
    "red",
    "orange",
    "yellow",
    "green",
    "blue",
    "indigo",
    "violet",
  ][getDay(con.start)];

  const colors = theme.variantColorResolver({
    theme,
    color,
    variant: "filled",
  });

  return (
    <>
      <RMarker latitude={lat} longitude={lng} onClick={onClick}>
        <IconMapPinFilled
          size={32}
          color={colors.background}
          style={{
            stroke: colors.color,
            marginTop: "-100%",
          }}
        />
      </RMarker>
      {showPopup ? (
        <RPopup latitude={lat} longitude={lng} offset={[0, -14]}>
          <ConRow
            con={con}
            showMonthInIcon
            showEndDateOnly={false}
            showLocation={false}
            showFollowed
            showLikeButton
            showBigIcon={false}
            showDuration={false}
          />
        </RPopup>
      ) : null}
    </>
  );
}

export default function Map({ cons }: { cons: ConWithPost[] }) {
  const colorScheme = useComputedColorScheme();
  const [selected, setSelected] = useState<string | null>();

  return (
    <Box px={{ base: 0, lg: "xs" }}>
      <RMap
        onClick={() => {
          setSelected(null);
        }}
        className={colorScheme}
        mapStyle={colorScheme == "light" ? lightStyle : darkStyle}
        initialCenter={[0, 0]}
        initialZoom={1}
        style={{ height: "800px" }}
      >
        {cons.map((con) => {
          return (
            <Pin
              key={con.slug}
              con={con}
              showPopup={con.slug == selected}
              onClick={(e) => {
                e.stopPropagation();
                setSelected(con.slug);
              }}
            />
          );
        })}
      </RMap>
    </Box>
  );
}
