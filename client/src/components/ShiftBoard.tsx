import { useState, useEffect } from 'react';
import { useToast } from './Toast';
import './ShiftBoard.css';

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

interface ShiftBoardProps {
  restaurantId: string;
}

type ViewType = 'day' | 'week' | 'month';

const ROLE_COLORS: Record<string, string> = {
  waiter: '#FF6B6B',
  chef: '#4ECDC4',
  manager: '#FFE66D',
  busser: '#95E1D3',
  host: '#C7B3E5',
  bartender: '#F38181',
};

const STATUS_COLORS: Record<string, string> = {
  scheduled: '#E8F5E9',
  checked_in: '#C8E6C9',
  checked_out: '#BDBDBD',
  called_out: '#FFE0B2',
  cancelled: '#FFCDD2',
};

// Helper functions
const getMonday = (date: Date): Date => {
  const d = new Date(date);
  const day = d.getDay();
  const diff = d.getDate() - day + (day === 0 ? -6 : 1);
  return new Date(d.setDate(diff));
};

const getWeekDates = (date: Date): Date[] => {
  const monday = getMonday(date);
  const dates: Date[] = [];
  for (let i = 0; i < 7; i++) {
    const d = new Date(monday);
    d.setDate(d.getDate() + i);
    dates.push(d);
  }
  return dates;
};

const formatDate = (date: Date): string => date.toISOString().split('T')[0];
const formatDateDisplay = (date: Date): string => date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
const formatMonthYear = (date: Date): string => date.toLocaleDateString('en-US', { month: 'long', year: 'numeric' });

export default function ShiftBoard({ restaurantId }: ShiftBoardProps) {
  const { toast } = useToast();
  const [staff, setStaff] = useState<StaffMember[]>([]);
  const [shifts, setShifts] = useState<ShiftAssignment[]>([]);
  const [selectedDate, setSelectedDate] = useState<string>(new Date().toISOString().split('T')[0]);
  const [viewType, setViewType] = useState<ViewType>('day');
  const [loading, setLoading] = useState(false);
  const [showAddStaffForm, setShowAddStaffForm] = useState(false);
  const [showAddShiftForm, setShowAddShiftForm] = useState(false);
  const [newStaff, setNewStaff] = useState({ firstName: '', lastName: '', email: '', role: 'waiter', userId: '' });
  const [newShift, setNewShift] = useState({ staffId: '', startTime: '09:00', endTime: '17:00' });

  useEffect(() => {
    loadData();
  }, [selectedDate, viewType, restaurantId]);

  const loadData = async () => {
    setLoading(true);
    try {
      const staffRes = await fetch(`/api/restaurants/${restaurantId}/staff`);
      if (staffRes.ok) setStaff(await staffRes.json());

      // Load shifts for the appropriate date range
      let startDate = selectedDate;
      let endDate = selectedDate;

      if (viewType === 'week') {
        const dates = getWeekDates(new Date(selectedDate));
        startDate = formatDate(dates[0]);
        endDate = formatDate(dates[6]);
      } else if (viewType === 'month') {
        const date = new Date(selectedDate);
        startDate = formatDate(new Date(date.getFullYear(), date.getMonth(), 1));
        endDate = formatDate(new Date(date.getFullYear(), date.getMonth() + 1, 0));
      }

      const shiftsRes = await fetch(`/api/restaurants/${restaurantId}/shifts?startDate=${startDate}&endDate=${endDate}`);
      if (shiftsRes.ok) setShifts(await shiftsRes.json());
    } catch (err) {
      console.error('Failed to load data:', err);
    } finally {
      setLoading(false);
    }
  };

  const handleAddStaff = async () => {
    if (!newStaff.firstName || !newStaff.lastName || !newStaff.email) {
      toast('Please fill in required fields', 'warning');
      return;
    }

    try {
      const res = await fetch(`/api/restaurants/${restaurantId}/staff`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(newStaff),
      });
      if (res.ok) {
        setNewStaff({ firstName: '', lastName: '', email: '', role: 'waiter', userId: '' });
        setShowAddStaffForm(false);
        loadData();
      }
    } catch (err) {
      console.error('Failed to add staff:', err);
    }
  };

  const handleAddShift = async () => {
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
        }),
      });
      if (res.ok) {
        setNewShift({ staffId: '', startTime: '09:00', endTime: '17:00' });
        setShowAddShiftForm(false);
        loadData();
      }
    } catch (err) {
      console.error('Failed to add shift:', err);
    }
  };

  const handleCheckIn = async (shiftId: string) => {
    try {
      await fetch(`/api/restaurants/${restaurantId}/shifts/${shiftId}/check-in`, { method: 'POST' });
      loadData();
    } catch (err) {
      console.error('Failed to check in:', err);
    }
  };

  const handleCheckOut = async (shiftId: string) => {
    try {
      await fetch(`/api/restaurants/${restaurantId}/shifts/${shiftId}/check-out`, { method: 'POST' });
      loadData();
    } catch (err) {
      console.error('Failed to check out:', err);
    }
  };

  const handleCancelShift = async (shiftId: string) => {
    try {
      await fetch(`/api/restaurants/${restaurantId}/shifts/${shiftId}`, { method: 'DELETE' });
      loadData();
    } catch (err) {
      console.error('Failed to cancel shift:', err);
    }
  };

  const changeDate = (days: number) => {
    const d = new Date(selectedDate);
    if (viewType === 'week') {
      d.setDate(d.getDate() + days * 7);
    } else if (viewType === 'month') {
      d.setMonth(d.getMonth() + days);
    } else {
      d.setDate(d.getDate() + days);
    }
    setSelectedDate(formatDate(d));
  };

  // Daily view component
  const DayView = () => {
    const date = new Date(selectedDate);
    const dayShifts = shifts.filter(s => s.date === selectedDate);
    const groupedShifts = new Map<string, ShiftAssignment[]>();
    dayShifts.forEach(shift => {
      if (!groupedShifts.has(shift.staffId)) groupedShifts.set(shift.staffId, []);
      groupedShifts.get(shift.staffId)!.push(shift);
    });

    const timeToMinutes = (time: string): number => {
      const [h, m] = time.split(':').map(Number);
      return h * 60 + m;
    };

    const DAY_START = 9 * 60;
    const DAY_END = 23 * 60;
    const TOTAL_MINUTES = DAY_END - DAY_START;

    return (
      <div className="shift-board day-view">
        <div className="day-view-header">
          <h2>{date.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' })}</h2>
        </div>
        <div className="day-timeline">
          <div className="time-slots">
            {Array.from({ length: 15 }, (_, i) => (
              <div key={i} className="time-slot">{9 + i}:00</div>
            ))}
          </div>
          <div className="staff-rows">
            {staff.map(member => (
              <div key={member.id} className="staff-row">
                <div className="staff-name" style={{ borderLeftColor: ROLE_COLORS[member.role] || '#999' }}>
                  <span>{member.firstName} {member.lastName}</span>
                  <small>{member.role}</small>
                </div>
                <div className="timeline-row">
                  {(groupedShifts.get(member.id) || []).map(shift => {
                    const startMins = timeToMinutes(shift.startTime);
                    const endMins = timeToMinutes(shift.endTime);
                    const left = ((startMins - DAY_START) / TOTAL_MINUTES) * 100;
                    const width = ((endMins - startMins) / TOTAL_MINUTES) * 100;

                    return (
                      <div
                        key={shift.id}
                        className="shift-bar"
                        style={{
                          left: `${left}%`,
                          width: `${width}%`,
                          backgroundColor: ROLE_COLORS[shift.staffRole] || '#999',
                          opacity: STATUS_COLORS[shift.status] ? 1 : 0.6,
                        }}
                        title={`${shift.startTime}-${shift.endTime} (${shift.status})`}
                      >
                        <span className="shift-time">{shift.startTime}-{shift.endTime}</span>
                        <div className="shift-actions">
                          {shift.status === 'scheduled' && (
                            <button onClick={() => handleCheckIn(shift.id)} className="btn-checkin">Check In</button>
                          )}
                          {shift.status === 'checked_in' && (
                            <button onClick={() => handleCheckOut(shift.id)} className="btn-checkout">Check Out</button>
                          )}
                          <button onClick={() => handleCancelShift(shift.id)} className="btn-cancel">Cancel</button>
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>
    );
  };

  // Weekly view component
  const WeekView = () => {
    const dates = getWeekDates(new Date(selectedDate));
    const weekShifts = shifts.filter(s => {
      const d = new Date(s.date);
      return d >= dates[0] && d <= dates[6];
    });

    const groupedByStaffAndDate = new Map<string, Map<string, ShiftAssignment[]>>();
    staff.forEach(m => {
      groupedByStaffAndDate.set(m.id, new Map());
      dates.forEach(d => {
        const dateStr = formatDate(d);
        groupedByStaffAndDate.get(m.id)!.set(dateStr, []);
      });
    });

    weekShifts.forEach(shift => {
      const staffMap = groupedByStaffAndDate.get(shift.staffId);
      if (staffMap) {
        const dayShifts = staffMap.get(shift.date) || [];
        dayShifts.push(shift);
        staffMap.set(shift.date, dayShifts);
      }
    });

    return (
      <div className="shift-board week-view">
        <div className="week-header">
          <h2>{formatDate(dates[0])} to {formatDate(dates[6])}</h2>
        </div>
        <div className="week-table">
          <div className="week-row header-row">
            <div className="staff-cell">Staff</div>
            {dates.map(d => (
              <div key={formatDate(d)} className="day-cell">
                <div>{d.toLocaleDateString('en-US', { weekday: 'short' })}</div>
                <div className="date-num">{formatDateDisplay(d)}</div>
              </div>
            ))}
          </div>
          {staff.map(member => (
            <div key={member.id} className="week-row">
              <div className="staff-cell">
                <div className="staff-info" style={{ borderLeftColor: ROLE_COLORS[member.role] || '#999' }}>
                  <span className="staff-name">{member.firstName} {member.lastName}</span>
                  <span className="staff-role">{member.role}</span>
                </div>
              </div>
              {dates.map(d => {
                const dateStr = formatDate(d);
                const dayShifts = groupedByStaffAndDate.get(member.id)?.get(dateStr) || [];
                return (
                  <div key={dateStr} className="day-cell">
                    {dayShifts.map(shift => (
                      <div
                        key={shift.id}
                        className="week-shift"
                        style={{ backgroundColor: ROLE_COLORS[shift.staffRole] || '#999' }}
                        title={`${shift.startTime}-${shift.endTime}`}
                      >
                        <small>{shift.startTime}-{shift.endTime}</small>
                      </div>
                    ))}
                  </div>
                );
              })}
            </div>
          ))}
        </div>
      </div>
    );
  };

  // Monthly view component
  const MonthView = () => {
    const date = new Date(selectedDate);
    const year = date.getFullYear();
    const month = date.getMonth();
    const firstDay = new Date(year, month, 1);
    const lastDay = new Date(year, month + 1, 0);
    const prevLastDay = new Date(year, month, 0).getDate();

    const days: (Date | null)[] = [];
    for (let i = firstDay.getDay() - 1; i >= 0; i--) {
      days.push(new Date(year, month - 1, prevLastDay - i));
    }
    for (let i = 1; i <= lastDay.getDate(); i++) {
      days.push(new Date(year, month, i));
    }
    const remaining = 42 - days.length;
    for (let i = 1; i <= remaining; i++) {
      days.push(new Date(year, month + 1, i));
    }

    return (
      <div className="shift-board month-view">
        <div className="month-header">
          <h2>{formatMonthYear(date)}</h2>
        </div>
        <div className="month-calendar">
          {['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].map(day => (
            <div key={day} className="day-header">{day}</div>
          ))}
          {days.map((d, i) => {
            const dateStr = d ? formatDate(d) : '';
            const dayShifts = d ? shifts.filter(s => s.date === dateStr) : [];
            const isCurrentMonth = d && d.getMonth() === month;

            return (
              <div key={i} className={`month-day ${isCurrentMonth ? 'current' : 'other'}`}>
                <div className="day-number">{d?.getDate()}</div>
                <div className="shift-count">
                  {dayShifts.length > 0 && (
                    <>
                      <div className="count-badge">{dayShifts.length} shifts</div>
                      <div className="shift-dots">
                        {staff.map(member => {
                          const hasShift = dayShifts.some(s => s.staffId === member.id);
                          return hasShift ? (
                            <span
                              key={member.id}
                              className="dot"
                              style={{ backgroundColor: ROLE_COLORS[member.role] || '#999' }}
                              title={member.firstName}
                            />
                          ) : null;
                        })}
                      </div>
                    </>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      </div>
    );
  };

  const currentDate = new Date(selectedDate);
  const displayText = viewType === 'week'
    ? `Week of ${formatDateDisplay(getWeekDates(currentDate)[0])}`
    : viewType === 'month'
    ? formatMonthYear(currentDate)
    : currentDate.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });

  return (
    <div className="shift-board-container">
      <div className="board-header">
        <div className="view-controls">
          <button
            className={`view-btn ${viewType === 'day' ? 'active' : ''}`}
            onClick={() => setViewType('day')}
          >
            Day
          </button>
          <button
            className={`view-btn ${viewType === 'week' ? 'active' : ''}`}
            onClick={() => setViewType('week')}
          >
            Week
          </button>
          <button
            className={`view-btn ${viewType === 'month' ? 'active' : ''}`}
            onClick={() => setViewType('month')}
          >
            Month
          </button>
        </div>

        <div className="date-controls">
          <button onClick={() => changeDate(-1)}>← Prev</button>
          <div className="current-date">{displayText}</div>
          <button onClick={() => changeDate(1)}>Next →</button>
          <input
            type="date"
            value={selectedDate}
            onChange={e => setSelectedDate(e.target.value)}
          />
        </div>

        <div className="action-buttons">
          <button className="btn-primary" onClick={() => setShowAddStaffForm(!showAddStaffForm)}>
            + Add Staff
          </button>
          <button className="btn-primary" onClick={() => setShowAddShiftForm(!showAddShiftForm)}>
            + Add Shift
          </button>
        </div>
      </div>

      {showAddStaffForm && (
        <div className="form-panel">
          <h3>Add Staff Member</h3>
          <input
            type="text"
            placeholder="First Name"
            value={newStaff.firstName}
            onChange={e => setNewStaff({ ...newStaff, firstName: e.target.value })}
          />
          <input
            type="text"
            placeholder="Last Name"
            value={newStaff.lastName}
            onChange={e => setNewStaff({ ...newStaff, lastName: e.target.value })}
          />
          <input
            type="email"
            placeholder="Email"
            value={newStaff.email}
            onChange={e => setNewStaff({ ...newStaff, email: e.target.value })}
          />
          <select value={newStaff.role} onChange={e => setNewStaff({ ...newStaff, role: e.target.value })}>
            <option value="waiter">Waiter</option>
            <option value="chef">Chef</option>
            <option value="manager">Manager</option>
            <option value="busser">Busser</option>
            <option value="host">Host</option>
            <option value="bartender">Bartender</option>
          </select>
          <button onClick={handleAddStaff} className="btn-primary">Save Staff</button>
          <button onClick={() => setShowAddStaffForm(false)} className="btn-secondary">Cancel</button>
        </div>
      )}

      {showAddShiftForm && (
        <div className="form-panel">
          <h3>Create Shift</h3>
          <select
            value={newShift.staffId}
            onChange={e => setNewShift({ ...newShift, staffId: e.target.value })}
          >
            <option value="">Select Staff Member</option>
            {staff.map(member => (
              <option key={member.id} value={member.id}>
                {member.firstName} {member.lastName}
              </option>
            ))}
          </select>
          <input
            type="time"
            value={newShift.startTime}
            onChange={e => setNewShift({ ...newShift, startTime: e.target.value })}
          />
          <input
            type="time"
            value={newShift.endTime}
            onChange={e => setNewShift({ ...newShift, endTime: e.target.value })}
          />
          <button onClick={handleAddShift} className="btn-primary">Create Shift</button>
          <button onClick={() => setShowAddShiftForm(false)} className="btn-secondary">Cancel</button>
        </div>
      )}

      {loading ? <p>Loading...</p> : (
        <>
          {viewType === 'day' && <DayView />}
          {viewType === 'week' && <WeekView />}
          {viewType === 'month' && <MonthView />}
        </>
      )}
    </div>
  );
}
