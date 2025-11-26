import ShiftScheduler from '../components/ShiftScheduler';
import '../styles/ShiftPage.css';

export default function ShiftPage() {
  // Get restaurant ID from URL params
  const params = new URLSearchParams(window.location.search);
  const restaurantId = params.get('restaurantId') || '';

  if (!restaurantId) {
    return (
      <div className="shift-page error">
        <p>Restaurant ID is required</p>
      </div>
    );
  }

  return (
    <div className="shift-page">
      <ShiftScheduler restaurantId={restaurantId} />
    </div>
  );
}
