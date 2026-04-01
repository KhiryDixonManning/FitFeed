
import { useState } from "react";

export default function Feed() {
  const [count, setCount] = useState(0);
  return (
    <div>
      <h1>Feed Page</h1>
      <button onClick={() => setCount(count + 1)}>
        Test Button (Clicked {count} times)
      </button>
    </div>
  );
}