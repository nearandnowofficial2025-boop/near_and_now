import { BrowserRouter as Router, Routes, Route } from 'react-router-dom';
import AdminLoginPage from './pages/admin/AdminLoginPage';
import AdminRoutes from './routes/AdminRoutes';
function App() {
  return (
    <Router>
      <Routes>
        <Route path="/login" element={<AdminLoginPage />} />
        <Route path="/*" element={<AdminRoutes />} />
      </Routes>
    </Router>
  );
}
export default App;
