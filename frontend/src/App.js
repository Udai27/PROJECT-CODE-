import React, { useEffect, useState } from "react";
import Dashboard from "./Dashboard"; // ✅ Tumhara frontend file
import "./App.css";

function App() {
  const [backendData, setBackendData] = useState(null);

  // ✅ Backend API call (server.js ke routes se data lena)
  useEffect(() => {
    fetch("http://localhost:8000/api/hello") // server.js ke API endpoint ka URL
      .then((res) => res.json())
      .then((data) => setBackendData(data))
      .catch((err) => console.error("Error fetching backend:", err));
  }, []);

  return (
    <div className="App">
      <h1>🚀 Rockfall Prediction Project</h1>

      {/* ✅ Dashboard load karo */}
      <Dashboard />

      {/* ✅ Backend se aya hua data dikhana */}
      <div style={{ marginTop: "20px" }}>
        <h3>Backend Response:</h3>
        {backendData ? <pre>{JSON.stringify(backendData, null, 2)}</pre> : "Loading..."}
      </div>
    </div>
  );
}

export default App;
