import { useState, useEffect } from 'react';
import { useToast } from './Toast';
import './ShiftScheduler.css';

interface StaffMember {
  id: string;
  firstName: string;
  lastName: string;
  email: string;
  role: string;
  status: string;
}

interface ShiftAssignment {
  id: string;
  staffId: string;
  staffName: string;
  staffRole: string;
  date: string;
  startTime: string;
  endTime: string;
  status: 'scheduled' | 'checked_in' | 'checked_out' | 'called_out' | 'cancelled';
  checkedInAt?: number;
  checkedOutAt?: number;
}

interface ShiftTemplate {
  id: string;
  name: string;
  startTime: string;
  endTime: string;
  daysOfWeek: number[];
}

interface ShiftSchedulerProps {
  restaurantId: string;
}

export default function ShiftScheduler({ restaurantId }: ShiftSchedulerProps) {
  const { toast, confirmDialog } = useToast();
  const [staff, setStaff] = useState<StaffMember[]>([]);
  const [templates, setTemplates] = useState<ShiftTemplate[]>([]);
  const [shifts, setShifts] = useState<ShiftAssignment[]>([]);
  const [selectedDate, setSelectedDate] = useState<string>(new Date().toISOString().split('T')[0]);
  const [showNewShiftForm, setShowNewShiftForm] = useState(false);
  const [showStaffForm, setShowStaffForm] = useState(false);
  const [loading, setLoading] = useState(false);
  const [stats, setStats] = useState<any>(null);

  const [newShift, setNewShift] = useState({
    staffId: '',
    startTime: '09:00',
    endTime: '17:00',
    shiftTemplateId: '',
  });

  const [newStaff, setNewStaff] = useState({
    firstName: '',
    lastName: '',
    email: '',
    role: 'waiter',
    userId: '',
  });

  // Load data on mount and when date changes
  useEffect(() => {
    loadData();
  }, [selectedDate, restaurantId]);

  const loadData = async () => {
    setLoading(true);
    try {
      const [staffRes, templatesRes, shiftsRes, statsRes] = await Promise.all([
        fetch(`/api/restaurants/${restaurantId}/staff`),
        fetch(`/api/restaurants/${restaurantId}/shift-templates`),
        fetch(`/api/restaurants/${restaurantId}/shifts?date=${selectedDate}`),
        fetch(`/api/restaurants/${restaurantId}/shift-stats?date=${selectedDate}`),
      ]);

      if (staffRes.ok) setStaff(await staffRes.json());
      if (templatesRes.ok) setTemplates(await templatesRes.json());
      if (shiftsRes.ok) setShifts(await shiftsRes.json());
      if (statsRes.ok) setStats(await statsRes.json());
    } catch (err) {
      console.error('Failed to load shift data:', err);
    } finally {
      setLoading(false);
    }
  };

  const handleCreateShift = async () => {
    if (!newShift.staffId) {
      toast('Please select a staff member', 'warning');
      return;
    }

    try {
      const res = await fetch(`/api/restaurants/${restaurantId}/shifts`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          staffId: newShift.staffId,
          date: selectedDate,
          startTime: newShift.startTime,
          endTime: newShift.endTime,
          shiftTemplateId: newShift.shiftTemplateId || undefined,
        }),
      });

      if (res.ok) {
        await loadData();
        setNewShift({ staffId: '', startTime: '09:00', endTime: '17:00', shiftTemplateId: '' });
        setShowNewShiftForm(false);
      }
    } catch (err) {
      console.error('Failed to create shift:', err);
    }
  };

  const handleCreateStaff = async () => {
    if (!newStaff.firstName || !newStaff.lastName || !newStaff.email) {
      toast('Please fill in all required fields', 'warning');
      return;
    }

    try {
      const res = await fetch(`/api/restaurants/${restaurantId}/staff`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ...newStaff,
          userId: newStaff.userId || crypto.randomUUID(),
        }),
      });

      if (res.ok) {
        await loadData();
        setNewStaff({ firstName: '', lastName: '', email: '', role: 'waiter', userId: '' });
        setShowStaffForm(false);
      }
    } catch (err) {
      console.error('Failed to create staff:', err);
    }
  };

  const handleCheckIn = async (shiftId: string) => {
    try {
      const res = await fetch(`/api/restaurants/${restaurantId}/shifts/${shiftId}/check-in`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });

      if (res.ok) await loadData();
    } catch (err) {
      console.error('Failed to check in:', err);
    }
  };

  const handleCheckOut = async (shiftId: string) => {
    try {
      const res = await fetch(`/api/restaurants/${restaurantId}/shifts/${shiftId}/check-out`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });

      if (res.ok) await loadData();
    } catch (err) {
      console.error('Failed to check out:', err);
    }
  };

  const handleCancelShift = async (shiftId: string) => {
    const confirmed = await confirmDialog('Are you sure you want to cancel this shift?');
    if (confirmed) {
      try {
        const res = await fetch(`/api/restaurants/${restaurantId}/shifts/${shiftId}`, {
          method: 'DELETE',
        });

        if (res.ok) await loadData();
      } catch (err) {
        console.error('Failed to cancel shift:', err);
      }
    }
  };

  const getStaffName = (staffId: string) => {
    const s = staff.find(m => m.id === staffId);
    return s ? `${s.firstName} ${s.lastName}` : 'Unknown';
  };

  const getStatusColor = (status: string) => {
    switch (status) {
      case 'checked_in': return '#4CAF50';
      case 'checked_out': return '#9E9E9E';
      case 'scheduled': return '#2196F3';
      case 'called_out': return '#FF9800';
      case 'cancelled': return '#F44336';
      default: return '#999';
    }
  };

  const previousDate = () => {
    const d = new Date(selectedDate);
    d.setDate(d.getDate() - 1);
    setSelectedDate(d.toISOString().split('T')[0]);
  };

  const nextDate = () => {
    const d = new Date(selectedDate);
    d.setDate(d.getDate() + 1);
    setSelectedDate(d.toISOString().split('T')[0]);
  };

  return (
    <div className="shift-scheduler">
      <header className="scheduler-header">
        <h1>📅 Shift Scheduler</h1>
        <div className="scheduler-controls">
          <button onClick={previousDate}>← Previous</button>
          <input
            type="date"
            value={selectedDate}
            onChange={(e) => setSelectedDate(e.target.value)}
            className="date-picker"
          />
          <button onClick={nextDate}>Next →</button>
        </div>
      </header>

      {loading && <div className="loading">Loading...</div>}

      {stats && (
        <div className="stats-summary">
          <div className="stat">
            <span className="stat-label">Total Shifts:</span>
            <span className="stat-value">{stats.totalShifts}</span>
          </div>
          <div className="stat">
            <span className="stat-label">Checked In:</span>
            <span className="stat-value">{stats.checkedIn}</span>
          </div>
          <div className="stat">
            <span className="stat-label">Checked Out:</span>
            <span className="stat-value">{stats.checkedOut}</span>
          </div>
          <div className="stat">
            <span className="stat-label">Scheduled:</span>
            <span className="stat-value">{stats.scheduled}</span>
          </div>
        </div>
      )}

      <div className="scheduler-actions">
        <button
          className="btn primary"
          onClick={() => setShowNewShiftForm(!showNewShiftForm)}
        >
          {showNewShiftForm ? '✕ Cancel' : '+ New Shift'}
        </button>
        <button
          className="btn secondary"
          onClick={() => setShowStaffForm(!showStaffForm)}
        >
          {showStaffForm ? '✕ Cancel' : '+ Add Staff'}
        </button>
      </div>

      {showNewShiftForm && (
        <div className="form-card">
          <h3>Create New Shift</h3>
          <div className="form-group">
            <label>Staff Member</label>
            <select
              value={newShift.staffId}
              onChange={(e) => setNewShift({ ...newShift, staffId: e.target.value })}
            >
              <option value="">Select staff member</option>
              {staff.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.firstName} {m.lastName} ({m.role})
                </option>
              ))}
            </select>
          </div>

          <div className="form-row">
            <div className="form-group">
              <label>Start Time</label>
              <input
                type="time"
                value={newShift.startTime}
                onChange={(e) => setNewShift({ ...newShift, startTime: e.target.value })}
              />
            </div>
            <div className="form-group">
              <label>End Time</label>
              <input
                type="time"
                value={newShift.endTime}
                onChange={(e) => setNewShift({ ...newShift, endTime: e.target.value })}
              />
            </div>
          </div>

          <div className="form-group">
            <label>Shift Template (optional)</label>
            <select
              value={newShift.shiftTemplateId}
              onChange={(e) => setNewShift({ ...newShift, shiftTemplateId: e.target.value })}
            >
              <option value="">No template</option>
              {templates.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.name} ({t.startTime}-{t.endTime})
                </option>
              ))}
            </select>
          </div>

          <button className="btn primary" onClick={handleCreateShift}>
            Create Shift
          </button>
        </div>
      )}

      {showStaffForm && (
        <div className="form-card">
          <h3>Add Staff Member</h3>
          <div className="form-row">
            <div className="form-group">
              <label>First Name</label>
              <input
                type="text"
                value={newStaff.firstName}
                onChange={(e) => setNewStaff({ ...newStaff, firstName: e.target.value })}
              />
            </div>
            <div className="form-group">
              <label>Last Name</label>
              <input
                type="text"
                value={newStaff.lastName}
                onChange={(e) => setNewStaff({ ...newStaff, lastName: e.target.value })}
              />
            </div>
          </div>

          <div className="form-group">
            <label>Email</label>
            <input
              type="email"
              value={newStaff.email}
              onChange={(e) => setNewStaff({ ...newStaff, email: e.target.value })}
            />
          </div>

          <div className="form-group">
            <label>Role</label>
            <select
              value={newStaff.role}
              onChange={(e) => setNewStaff({ ...newStaff, role: e.target.value })}
            >
              <option value="waiter">Waiter</option>
              <option value="manager">Manager</option>
              <option value="chef">Chef</option>
              <option value="busser">Busser</option>
              <option value="host">Host</option>
              <option value="bartender">Bartender</option>
            </select>
          </div>

          <button className="btn primary" onClick={handleCreateStaff}>
            Add Staff
          </button>
        </div>
      )}

      <div className="shifts-container">
        <h2>Shifts for {selectedDate}</h2>
        {shifts.length === 0 ? (
          <p className="empty-state">No shifts scheduled for this date</p>
        ) : (
          <div className="shifts-grid">
            {shifts.map((shift) => (
              <div
                key={shift.id}
                className="shift-card"
                style={{ borderLeftColor: getStatusColor(shift.status) }}
              >
                <div className="shift-header">
                  <h4>{shift.staffName}</h4>
                  <span className={`shift-status ${shift.status}`}>{shift.status}</span>
                </div>

                <div className="shift-details">
                  <div className="detail">
                    <span className="label">Role:</span>
                    <span className="value">{shift.staffRole}</span>
                  </div>
                  <div className="detail">
                    <span className="label">Time:</span>
                    <span className="value">
                      {shift.startTime} - {shift.endTime}
                    </span>
                  </div>
                  {shift.checkedInAt && (
                    <div className="detail">
                      <span className="label">Checked In:</span>
                      <span className="value">
                        {new Date(shift.checkedInAt).toLocaleTimeString()}
                      </span>
                    </div>
                  )}
                </div>

                <div className="shift-actions">
                  {shift.status === 'scheduled' && (
                    <button className="btn small success" onClick={() => handleCheckIn(shift.id)}>
                      Check In
                    </button>
                  )}
                  {shift.status === 'checked_in' && (
                    <button className="btn small warning" onClick={() => handleCheckOut(shift.id)}>
                      Check Out
                    </button>
                  )}
                  {shift.status !== 'checked_out' && shift.status !== 'cancelled' && (
                    <button
                      className="btn small danger"
                      onClick={() => handleCancelShift(shift.id)}
                    >
                      Cancel
                    </button>
                  )}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
