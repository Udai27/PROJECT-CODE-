import logo from './logo.svg';
import './App.css';

// 👇 Apne components import karo
import PredictivePage from './PredictivePage';
import FieldWorkerDashboard from './FieldWorkerDashboard';
import AIPredictiveContent from './AIPredictiveContent';

function App() {
  return (
    <div className="App">
      {/* Default React Template (same as before) */}
      <header className="App-header">
        <img src={logo} className="App-logo" alt="logo" />
        <p>
          Edit <code>src/App.js</code> and save to reload.
        </p>
        <a
          className="App-link"
          href="https://reactjs.org"
          target="_blank"
          rel="noopener noreferrer"
        >
          Learn React
        </a>
      </header>

      {/* 👇 Tumhara custom project UI */}
      <main style={{ padding: "20px" }}>
        <h1>🚀 Rockfall Prediction Dashboard</h1>

        {/* Predictive Page */}
        <section style={{ margin: "20px 0" }}>
          <h2>Predictive Page</h2>
          <PredictivePage />
        </section>

        {/* Field Worker Dashboard */}
        <section style={{ margin: "20px 0" }}>
          <h2>Field Worker Dashboard</h2>
          <FieldWorkerDashboard />
        </section>

        {/* AI Predictive Content */}
        <section style={{ margin: "20px 0" }}>
          <h2>AI Predictive Content</h2>
          <AIPredictiveContent />
        </section>
      </main>
    </div>
  );
}

export default App;
