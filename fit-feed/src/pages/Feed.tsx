
import { useState } from "react";
import Headbar from "../components/Headbar";

export default function Feed() {
  const [count, setCount] = useState(0);
  return (
    <div>
      <Headbar />
    </div>
  );
}