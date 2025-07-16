import { MapContainer, TileLayer, Marker } from "react-leaflet";
import { ConWithPost } from "~/hooks";

export default function Map({ cons }: { cons: ConWithPost[] }) {
  return (
    <MapContainer center={[0, 0]} zoom={2} style={{ height: "800px" }}>
      <TileLayer
        attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'
        url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
      />
      {cons.flatMap((con) => {
        const latLng = con.geocoded?.latLng;
        if (latLng == null) {
          return [];
        }
        const [lat, lng] = latLng;
        return [
          <Marker
            key={con.slug}
            position={[parseFloat(lat), parseFloat(lng)]}
          />,
        ];
      })}
    </MapContainer>
  );
}
